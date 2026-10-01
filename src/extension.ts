import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { createIcebergApi, type IcebergApi } from './api';
import { pickBearName } from './bearNames';
import { ChatUsageWatcher } from './chatWatcher';
import { DashboardViewProvider, openDashboardPanel } from './dashboardView';
import { IcebergViewProvider, openHabitatPanel } from './habitatView';
import { identityCaptureOverride, OtelWatcher } from './otelWatcher';
import { buildSnapshot, redactUrl, selectedSession, sessionComparisons, sessionLabel, type DashboardSnapshot, type SessionComparison } from './otelSummary';
import {
  BACKUP_KEY,
  CONNECT_KEYS,
  RESET_KEY,
  SealableMemento,
  contributedSettings,
  describeAction,
  legacyActions,
  planCopilotRestore,
  planSettingsReset,
  recordBackup,
  type SettingsBackup
} from './restore';
import { TokenMeter, type UsageSnapshot } from './tokenMeter';

export type { IcebergApi, UsageReport, UsageSnapshot } from './api';

const OTEL_SECTION = 'github.copilot.chat.otel';

export function activate(context: vscode.ExtensionContext): IcebergApi {
  const conflict = findConflictingInstall(context.extension);
  if (conflict) {
    return standDown(context, conflict);
  }

  // Sealable so that restoring defaults cannot be undone by a pending save or
  // the persist-on-dispose that runs when the window reloads.
  const globalState = new SealableMemento(context.globalState, RESET_KEY);
  const workspaceState = new SealableMemento(context.workspaceState);
  const storage = { globalState, globalStorageUri: context.globalStorageUri };

  const meter = new TokenMeter(globalState);
  const api = createIcebergApi(meter);
  context.subscriptions.push(meter);

  const output = vscode.window.createOutputChannel('Iceberg');
  context.subscriptions.push(output);
  const log = (message: string) => output.appendLine(`[${new Date().toISOString()}] ${message}`);
  let selectedSessionId = workspaceState.get<string>('iceberg.selectedSession');

  // Watchers observe the same traffic; the meter reconciles their cumulative totals.
  const watcher = new ChatUsageWatcher(
    storage,
    (credits) => meter.observeTranscriptCredits(credits),
    log
  );
  context.subscriptions.push(watcher);
  watcher.start();

  const otel = new OtelWatcher(
    storage,
    (delta) => meter.observe(delta.source ?? 'otel', delta.input, delta.output, delta.requests),
    log
  );
  context.subscriptions.push(otel);
  otel.start();

  const updateContext = () => {
    const session = selectedSession({ transcripts: watcher.sessions, spans: otel.spanDigest, selectedSessionId });
    meter.setContext(session?.trace?.context);
    meter.refreshBasis();
  };
  context.subscriptions.push(
    otel.onDidScan(updateContext),
    watcher.onDidScan(updateContext)
  );
  updateContext();

  // Restore stops the watchers; its own setting changes must not restart them.
  let suspended = false;
  const suspend = () => {
    suspended = true;
  };

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (suspended || globalState.isSealed) {
        return;
      }
      if (
        e.affectsConfiguration('iceberg.trackCopilotChat') ||
        e.affectsConfiguration('iceberg.chatPollIntervalMs')
      ) {
        watcher.reconfigure();
      }
      if (e.affectsConfiguration('iceberg.otel') || e.affectsConfiguration(OTEL_SECTION)) {
        otel.reconfigure();
      }
    })
  );

  const snapshot = (): DashboardSnapshot => {
    const usage = meter.snapshot();
    return buildSnapshot({
      rollup: otel.rollup,
      spans: otel.spanDigest,
      feed: otel.health(),
      bearName: usage.bearName,
      budget: usage.budget,
      countedTokens: usage.total,
      meterSinceMs: meter.since,
      health: usage.health,
      totals: { input: usage.input, output: usage.output, credits: usage.credits },
      source: usage.source,
      basis: usage.basis,
      context: usage.context,
      drift: usage.drift,
      manualTokens: usage.manualTokens,
      legacyTokens: usage.legacyTokens,
      transcripts: watcher.sessions,
      selectedSessionId
    });
  };

  // The dashboard has to follow the telemetry as well as the meter: quality and
  // speed signals move without any token being charged, so a meter-only
  // subscription would leave those two sections stale.
  const changed = new vscode.EventEmitter<void>();
  context.subscriptions.push(
    changed,
    meter.onDidChange(() => changed.fire()),
    otel.onDidScan(() => changed.fire()),
    watcher.onDidScan(() => changed.fire())
  );

  const provider = new IcebergViewProvider(context.extensionUri, meter);
  const dashboard = new DashboardViewProvider(context.extensionUri, snapshot, changed.event);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(IcebergViewProvider.viewType, provider, {
      webviewOptions: { retainContextWhenHidden: true }
    }),
    vscode.window.registerWebviewViewProvider(DashboardViewProvider.viewType, dashboard, {
      webviewOptions: { retainContextWhenHidden: true }
    })
  );

  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 99);
  status.command = 'iceberg.showStats';
  context.subscriptions.push(status);

  const renderStatus = (s: UsageSnapshot) => {
    if (!vscode.workspace.getConfiguration('iceberg').get<boolean>('statusBar', true)) {
      status.hide();
      return;
    }
    const pct = Math.round(s.health * 100);
    status.text = `$(snowflake) ${s.basis === 'unavailable' ? '—' : s.basis === 'demo' ? 'Demo' : `${pct}%`}`;
    status.tooltip = new vscode.MarkdownString(
      [
        `**Bear in Mind** — ${iceReadout(s)}`,
        '',
        ...(s.basis === 'context' && s.context
          ? [`- Session: ${s.context.sessionId ?? 'not reported'}; ${s.context.model ?? 'unknown model'} at ${new Date(s.context.atMs).toISOString()}; prompt allowance, not the model picker's full window.`]
          : []),
        `- Local totals: input \`${fmt(s.input)}\` · output \`${fmt(s.output)}\``,
        `- Observed model calls + manual reports: \`${s.requests}\`` +
          ` · Reported credits: ${s.credits > 0 ? `\`${s.credits.toFixed(1)}\`` : 'not reported'}`,
        `- Across local sessions/workspaces since ${new Date(meter.since).toISOString()}; not selected-session cost.`,
        `- Source: ${s.source === 'otel' ? 'OpenTelemetry (metrics/spans, not added together)' : 'awaiting telemetry'}`,
        `- Explicit manual reports: ${fmt(s.manualTokens)} tokens; excluded legacy estimates: ${fmt(s.legacyTokens)}.`,
        '- Account usage and monthly credit allowance are not read.',
        '',
        `${s.bearName} ${moodLine(s.health)}`,
        '',
        '_Iceberg only shows the burn — it cannot cap it. The bear is relying on your compassion._'
      ].join('\n')
    );
    status.backgroundColor =
      s.health <= 0.1
        ? new vscode.ThemeColor('statusBarItem.errorBackground')
        : s.health <= 0.25
          ? new vscode.ThemeColor('statusBarItem.warningBackground')
          : undefined;
    status.show();
  };
  renderStatus(meter.snapshot());
  context.subscriptions.push(meter.onDidChange(renderStatus));

  context.subscriptions.push(
    vscode.commands.registerCommand('iceberg.open', () => openHabitatPanel(context.extensionUri, meter)),

    vscode.commands.registerCommand('iceberg.openDashboard', () =>
      openDashboardPanel(context.extensionUri, snapshot, changed.event)
    ),

    vscode.commands.registerCommand('iceberg.report', api.reportUsage),

    vscode.commands.registerCommand('iceberg.nameBear', () => pickBearName(meter.snapshot().bearName)),

    vscode.commands.registerCommand('iceberg.connectTelemetry', () => connectTelemetry(otel, output, globalState)),

    vscode.commands.registerCommand('iceberg.restoreDefaults', () =>
      restoreDefaults({ context, otel, watcher, globalState, workspaceState, output, suspend })
    ),

    vscode.commands.registerCommand('iceberg.telemetryDiagnostics', () => showDiagnostics(otel, meter, output, snapshot().session)),

    vscode.commands.registerCommand('iceberg.selectSession', async () => {
      const choices = [
        { label: 'Latest observed session', description: 'Not automatically the active VS Code chat', sessionId: undefined },
        ...sessionComparisons(watcher.sessions, otel.spanDigest.sessions).map((session) => ({
          label: sessionLabel(session),
          description: [
            session.trace?.model ?? session.transcript?.model ?? 'unknown model',
            session.work,
            session.trace?.user ? `by ${session.trace.user}` : undefined,
            new Date(session.updatedAt).toLocaleString()
          ].filter(Boolean).join(' · '),
          detail: session.sessionId,
          sessionId: session.sessionId
        }))
      ];
      const choice = await vscode.window.showQuickPick(choices, {
        title: 'Session to compare with Copilot',
        matchOnDescription: true,
        matchOnDetail: true,
        placeHolder: 'Pick a session by name, repository or user, or follow the most recently observed session'
      });
      if (choice) {
        selectedSessionId = choice.sessionId;
        await workspaceState.update('iceberg.selectedSession', selectedSessionId);
        updateContext();
        changed.fire();
      }
    }),

    vscode.commands.registerCommand('iceberg.showStats', async () => {
      const s = meter.snapshot();
      const source = s.source === 'otel' ? 'metered by OpenTelemetry' : 'awaiting telemetry (manual reports only)';
      const pick = await vscode.window.showInformationMessage(
        `${iceReadout(s)}. Local totals across sessions/workspaces: ` +
          `in ${fmt(s.input)}, out ${fmt(s.output)}, ${s.requests} model calls + manual reports; ` +
          `reported credits ${s.credits > 0 ? s.credits.toFixed(1) : 'not reported'} · ${source}. ` +
          `Not selected-session cost or account usage; the monthly credit allowance is not read.`,
        'Open Dashboard',
        'Open Habitat'
      );
      if (pick === 'Open Dashboard') {
        openDashboardPanel(context.extensionUri, snapshot, changed.event);
      } else if (pick === 'Open Habitat') {
        openHabitatPanel(context.extensionUri, meter);
      }
    }),

    vscode.commands.registerCommand('iceberg.toggleMeltdownDemo', () => {
      const on = meter.toggleDemo();
      void vscode.window.showInformationMessage(
        on ? 'Iceberg: meltdown demo running…' : 'Iceberg: meltdown demo stopped.'
      );
    })
  );

  registerChatParticipant(context, meter);

  return api;
}

/** Trace storage is additive; the file feed replaces OTLP, so ask before changing it. */
async function connectTelemetry(
  otel: OtelWatcher,
  output: vscode.OutputChannel,
  globalState: SealableMemento
): Promise<void> {
  if (globalState.isSealed) {
    await promptReload('Bear in Mind was just restored to its defaults. Reload the window before connecting again.');
    return;
  }
  const config = vscode.workspace.getConfiguration(OTEL_SECTION);
  const endpoint = (config.get<string>('otlpEndpoint', '') || '').trim();
  // Every user-facing mention of the endpoint uses this. The raw value is only
  // ever used to decide *whether* a collector is configured, never displayed.
  const endpointLabel = redactUrl(endpoint);
  const exporterType = (config.get<string>('exporterType', '') || '').trim();
  const collectorInUse = !!endpoint && exporterType !== 'file';

  // `dbSpanExporter` only exists in newer Copilot Chat builds. Offering the
  // trace store where the setting is unregistered would promise exact timings
  // and context-window headroom that can never arrive, so check before offering.
  const traceSetting = config.inspect('dbSpanExporter.enabled')?.defaultValue !== undefined
    ? 'dbSpanExporter.enabled' : 'dbSpanExporter';
  const traceStoreAvailable = config.inspect(traceSetting)?.defaultValue !== undefined;

  const traceStore = {
    label: 'Local trace store',
    detail: 'Cost and speed, with exact session timings. Runs alongside any collector you already use.',
    id: 'sqlite' as const
  };
  const fileFeed = {
    label: 'File feed',
    detail: collectorInUse
      ? `Adds quality signals — but replaces your OTLP exporter, so ${endpointLabel} stops receiving data.`
      : 'Adds quality signals: accept/reject, edit survival, pull requests and feedback.',
    id: 'file' as const
  };
  const both = {
    label: 'Both',
    detail: collectorInUse
      ? `Everything in all three sections — but ${endpointLabel} stops receiving data.`
      : 'Everything in all three sections. Recommended.',
    id: 'both' as const
  };

  const restore = {
    label: 'Restore defaults and disconnect…',
    detail: 'Undo the Copilot settings Bear in Mind changed, reset its settings and clear its stored data.',
    id: 'restore' as const
  };
  const separator = { label: '', kind: vscode.QuickPickItemKind.Separator, id: undefined };

  const sources = traceStoreAvailable ? [traceStore, both, fileFeed] : [fileFeed];
  const choices = [...sources, separator, restore];
  const placeHolder = !traceStoreAvailable
    ? 'This Copilot Chat has no local trace store, so the file feed is the only source'
    : collectorInUse
      ? `An OTLP endpoint is configured (${endpointLabel}) — only the trace store leaves it intact`
      : 'Everything stays on this machine; nothing is sent anywhere';

  const picked = await vscode.window.showQuickPick(choices, {
    title: 'Connect Copilot telemetry to Bear in Mind',
    placeHolder
  });
  if (!picked?.id) {
    return;
  }
  if (picked.id === 'restore') {
    await vscode.commands.executeCommand('iceberg.restoreDefaults');
    return;
  }

  if (collectorInUse && picked.id !== 'sqlite') {
    const proceed = await vscode.window.showWarningMessage(
      `This replaces your OTLP exporter. Copilot Chat will stop sending telemetry to ${endpointLabel}.`,
      { modal: true },
      'Replace it'
    );
    if (proceed !== 'Replace it') {
      return;
    }
  }

  // Identity is opt-in upstream and reaches every exporter, so it is asked for
  // separately and only offered where this Copilot Chat build has the setting.
  // COPILOT_OTEL_CAPTURE_IDENTITY outranks the setting, so asking would offer a
  // choice that has no effect.
  let captureIdentity = false;
  const identityOverride = identityCaptureOverride();
  if (identityOverride !== undefined) {
    output.appendLine(
      `[iceberg] COPILOT_OTEL_CAPTURE_IDENTITY=${process.env.COPILOT_OTEL_CAPTURE_IDENTITY} turns identity capture ` +
        `${identityOverride ? 'on' : 'off'} regardless of ${OTEL_SECTION}.captureIdentity, so that setting was not offered or changed.`
    );
  } else if (config.inspect('captureIdentity')?.defaultValue !== undefined && config.get<boolean>('captureIdentity') !== true) {
    const attribute = 'Attribute to My Account';
    const skip = 'Not Now';
    const answer = await vscode.window.showInformationMessage(
      'Attribute Copilot usage to your GitHub account?',
      {
        modal: true,
        detail:
          'Turns on github.copilot.chat.otel.captureIdentity (VS Code 1.140+). Agent spans then carry user.name, ' +
          'your GitHub account, and telemetry resources carry process.user.name and host.name. Bear in Mind ' +
          'reads it locally to group model-call credits by user and label sessions, and sends it nowhere. ' +
          (collectorInUse && picked.id === 'sqlite'
            ? `Your OTLP collector (${endpointLabel}) receives these attributes too. `
            : '') +
          'An organization policy can still deny identity capture. Restore Defaults puts your previous value back.'
      },
      attribute,
      skip
    );
    if (answer === undefined) {
      return;
    }
    captureIdentity = answer === attribute;
  }

  const wanted: Array<[string, unknown]> = [['enabled', true]];
  if (picked.id === 'sqlite' || picked.id === 'both') {
    wanted.push([traceSetting, true]);
  }
  if (picked.id === 'file' || picked.id === 'both') {
    // If the user has pinned `iceberg.otel.feedPath`, that is the file the
    // watcher will tail. Pointing Copilot at our default instead would report a
    // successful connection while the dashboard stayed empty for ever.
    const override = (vscode.workspace.getConfiguration('iceberg').get<string>('otel.feedPath', '') || '').trim();
    const feed = override || otel.defaultFeedPath();

    // Copilot Chat's file exporter opens a write stream without creating the
    // directory first, so pointing it at a folder that does not exist yet means
    // nothing is ever written and the feed stays silently empty.
    try {
      fs.mkdirSync(path.dirname(feed), { recursive: true });
    } catch (err) {
      // Carrying on here would do the precise damage this guard exists to
      // prevent: replace a working collector and leave a feed that can never be
      // written to.
      output.appendLine(`[iceberg] could not create the feed directory: ${String(err)}`);
      const show = 'Show Log';
      const choice = await vscode.window.showErrorMessage(
        `Could not create the folder for the telemetry feed (${path.dirname(feed)}). ` +
          'Nothing has been changed.',
        show
      );
      if (choice === show) {
        output.show(true);
      }
      return;
    }
    wanted.push(['outfile', feed], ['exporterType', 'file']);
  }
  // Last, so it is written only after the exporter writes it depends on.
  if (captureIdentity) {
    wanted.push(['captureIdentity', true]);
  }

  const applied: string[] = [];
  const failed: string[] = [];
  // Another window may have restored defaults while the picker was open.
  if (globalState.isSealed) {
    await promptReload('Bear in Mind was restored to its defaults in another window. Reload before connecting again.');
    return;
  }
  let backup = globalState.get<SettingsBackup>(BACKUP_KEY);
  // Configuration objects are snapshots; read the values as they are now, after
  // the picker, so the backup records what the user actually had.
  const live = vscode.workspace.getConfiguration(OTEL_SECTION);
  const liveEndpoint = (live.get<string>('otlpEndpoint', '') || '').trim();
  const liveCollector = !!liveEndpoint && (live.get<string>('exporterType', '') || '').trim() !== 'file';
  if (liveEndpoint !== endpoint || liveCollector !== collectorInUse) {
    // The warning about replacing a collector was based on the old values.
    void vscode.window.showWarningMessage(
      "Copilot's telemetry exporter changed while the picker was open, so nothing was changed. Run Connect again."
    );
    return;
  }
  // Values an earlier Bear in Mind wrote, before backups existed, are not the
  // user's originals; recording them would make a later restore a no-op.
  const before: Record<string, unknown> = {};
  for (const key of CONNECT_KEYS) {
    before[key] = live.inspect(key)?.globalValue;
  }
  const feedOverride = (vscode.workspace.getConfiguration('iceberg').get<string>('otel.feedPath', '') || '').trim();
  const ownedEarlier = new Set(
    legacyActions({
      current: before,
      backup,
      feedPaths: [otel.defaultFeedPath(), feedOverride].filter(Boolean),
      collectorConfigured: !!endpoint
    }).filter((action) => action.kind === 'remove').map((action) => action.key)
  );
  for (const [key, value] of wanted) {
    // The identity prompt only disclosed a kept collector. If replacing it
    // failed, that collector would receive the identity without the user being told.
    if (key === 'captureIdentity' && collectorInUse && picked.id !== 'sqlite' &&
        (failed.includes('outfile') || failed.includes('exporterType'))) {
      failed.push(key);
      output.appendLine(
        `[iceberg] ${OTEL_SECTION}.${key} was not turned on: the OTLP exporter could not be replaced, ` +
          `so ${endpointLabel} would have received your identity.`
      );
      continue;
    }
    // A setting this build of Copilot Chat does not register cannot be written —
    // `update` rejects. Writing them one at a time, and checking first, means one
    // unknown key cannot abort the rest of the setup.
    const known = live.inspect(key);
    if (!known || known.defaultValue === undefined) {
      failed.push(key);
      output.appendLine(`[iceberg] ${OTEL_SECTION}.${key} is not a setting in this VS Code build; skipped.`);
      continue;
    }
    try {
      await live.update(key, value, vscode.ConfigurationTarget.Global);
      applied.push(key);
      // Remember the user's own value so Restore Defaults can put it back.
      backup = recordBackup(backup, key, ownedEarlier.has(key) ? undefined : known.globalValue, value);
    } catch (err) {
      failed.push(key);
      output.appendLine(`[iceberg] could not set ${OTEL_SECTION}.${key}: ${String(err)}`);
    }
  }
  if (backup) {
    await globalState.update(BACKUP_KEY, backup);
  }

  otel.reconfigure();

  if (applied.length === 0) {
    const show = 'Show Log';
    const choice = await vscode.window.showErrorMessage(
      'Could not turn on Copilot telemetry — none of the settings could be written. ' +
        'This usually means the installed Copilot Chat is older than the telemetry feature.',
      show
    );
    if (choice === show) {
      output.show(true);
    }
    return;
  }

  const reload = 'Reload Window';
  const note =
    failed.length > 0
      ? ` (${failed.join(', ')} could not be set — see the Iceberg output channel)`
      : '';
  const choice = await vscode.window.showInformationMessage(
    `Copilot telemetry connected${note}. Reload so Copilot Chat picks up the change, then send a chat ` +
      'request to populate the dashboard.',
    reload
  );
  if (choice === reload) {
    await vscode.commands.executeCommand('workbench.action.reloadWindow');
  }
}

interface RestoreContext {
  context: vscode.ExtensionContext;
  otel: OtelWatcher;
  watcher: ChatUsageWatcher;
  globalState: SealableMemento;
  workspaceState: SealableMemento;
  output: vscode.OutputChannel;
  /** Stops configuration changes restarting the watchers until the window reloads. */
  suspend(): void;
}

/**
 * Returns VS Code to how it was before Bear in Mind: Copilot telemetry settings
 * back to the user's own values, Bear in Mind's user settings to their defaults,
 * and its stored data and feed file removed. Copilot's own files are untouched.
 */
async function restoreDefaults({ context, otel, watcher, globalState, workspaceState, output, suspend }: RestoreContext): Promise<void> {
  if (globalState.isSealed) {
    await promptReload('Bear in Mind is already restored to its defaults. Reload the window to finish.');
    return;
  }

  const copilot = vscode.workspace.getConfiguration(OTEL_SECTION);
  const root = vscode.workspace.getConfiguration();
  const plan = () => {
    // Configuration objects are snapshots, so fetch fresh ones on every call.
    const copilotNow = vscode.workspace.getConfiguration(OTEL_SECTION);
    const rootNow = vscode.workspace.getConfiguration();
    const current: Record<string, unknown> = {};
    for (const key of CONNECT_KEYS) {
      current[key] = copilotNow.inspect(key)?.globalValue;
    }
    const feedOverride = (vscode.workspace.getConfiguration('iceberg').get<string>('otel.feedPath', '') || '').trim();
    const copilotPlan = planCopilotRestore({
      current,
      backup: globalState.get<SettingsBackup>(BACKUP_KEY),
      feedPaths: [otel.defaultFeedPath(), feedOverride].filter(Boolean),
      collectorConfigured: !!(copilotNow.get<string>('otlpEndpoint', '') || '').trim()
    });
    // Only user settings are reset: workspace settings belong to the project and
    // may be shared with others through source control.
    const settingsPlan = planSettingsReset(contributedSettings(context.extension?.packageJSON), (key) => rootNow.inspect(key));
    return {
      copilotChanges: copilotPlan.filter((action) => action.kind !== 'keep'),
      copilotKept: copilotPlan.filter((action) => action.kind === 'keep'),
      userSettings: settingsPlan.filter((entry) => entry.scopes.includes('global')).map((entry) => entry.key),
      workspaceSettings: settingsPlan.filter((entry) => entry.scopes.some((scope) => scope !== 'global')).map((entry) => entry.key)
    };
  };
  const confirmed = plan();
  const { copilotChanges, copilotKept, userSettings, workspaceSettings } = confirmed;

  const detail = [
    'Copilot Chat telemetry settings:',
    ...(copilotChanges.length > 0
      ? copilotChanges.map((action) => `  • ${describeAction(OTEL_SECTION, action)}`)
      : ['  • nothing to undo']),
    ...copilotKept.map((action) => `  • ${describeAction(OTEL_SECTION, action)}`),
    '',
    `Bear in Mind settings: ${userSettings.length > 0 ? `${userSettings.length} reset to default (${userSettings.join(', ')})` : 'already at defaults'}.`,
    ...(workspaceSettings.length > 0 ? [`Workspace settings left alone: ${workspaceSettings.join(', ')}.`] : []),
    'Stored data: the meter history, session pin and Bear in Mind\'s own storage folder (the default feed file) are deleted. ' +
      'A custom iceberg.otel.feedPath file is kept. Other open windows stop saving and start fresh when reloaded.',
    '',
    "Copilot's own trace store and transcripts are not touched. Reload the window afterwards so Copilot Chat applies the restored settings."
  ].join('\n');

  const confirm = 'Restore and Disconnect';
  const answer = await vscode.window.showWarningMessage(
    'Restore Bear in Mind to its defaults and disconnect it from Copilot telemetry?',
    { modal: true, detail },
    confirm
  );
  if (answer !== confirm) {
    return;
  }
  // The dialog is modal only to this window: another window may have restored
  // defaults, or the user may have changed a listed setting, while it was open.
  if (globalState.isSealed) {
    await promptReload('Bear in Mind was restored to its defaults in another window. Reload the window to finish.');
    return;
  }
  if (JSON.stringify(plan()) !== JSON.stringify(confirmed)) {
    void vscode.window.showWarningMessage(
      'Settings changed while the confirmation was open, so nothing was changed. Run Restore Defaults again to review the new plan.'
    );
    return;
  }

  suspend();
  otel.stop();
  watcher.stop();
  // Announce the reset before touching settings, so a Connect running in
  // another window refuses rather than re-enabling telemetry mid-restore.
  await globalState.seal();
  await workspaceState.seal();
  output.appendLine(`[${new Date().toISOString()}] restoring defaults`);

  const failed: string[] = [];
  for (const action of copilotChanges) {
    try {
      await copilot.update(action.key, action.kind === 'restore' ? action.value : undefined, vscode.ConfigurationTarget.Global);
      output.appendLine(`  ${describeAction(OTEL_SECTION, action)}`);
    } catch (err) {
      failed.push(`${OTEL_SECTION}.${action.key}`);
      output.appendLine(`  could not change ${OTEL_SECTION}.${action.key}: ${String(err)}`);
    }
  }
  if (failed.length > 0) {
    // The backup is the only record of the user's previous values, so it and
    // all other stored data are kept; after a reload a retry finishes the job.
    const show = 'Show Log';
    const choice = await vscode.window.showErrorMessage(
      `Could not restore ${failed.join(', ')}. Bear in Mind's settings and stored data were kept. ` +
        'Reload the window, then run Restore Defaults again.',
      'Reload Window',
      show
    );
    if (choice === show) {
      output.show(true);
    } else if (choice) {
      await vscode.commands.executeCommand('workbench.action.reloadWindow');
    }
    return;
  }
  for (const action of copilotKept) {
    output.appendLine(`  ${describeAction(OTEL_SECTION, action)}`);
  }
  for (const key of userSettings) {
    try {
      await root.update(key, undefined, vscode.ConfigurationTarget.Global);
      output.appendLine(`  ${key} → default`);
    } catch (err) {
      failed.push(key);
      output.appendLine(`  could not reset ${key}: ${String(err)}`);
    }
  }

  // Clearing seals both stores, so nothing is written back before the reload.
  await globalState.clear();
  await workspaceState.clear();

  // The directory is ours alone and only holds the feed. Leave it if Copilot is
  // still told to write there, since removing it would silently break that.
  const storageDir = context.globalStorageUri.fsPath;
  const outfile = (vscode.workspace.getConfiguration(OTEL_SECTION).get<string>('outfile', '') || '').trim();
  if (outfile && isInside(storageDir, outfile)) {
    output.appendLine(`  kept ${storageDir}: Copilot Chat still writes its feed there`);
  } else {
    try {
      fs.rmSync(storageDir, { recursive: true, force: true });
      output.appendLine(`  deleted ${storageDir}`);
    } catch (err) {
      output.appendLine(`  could not delete ${storageDir}: ${String(err)}`);
    }
  }

  const note = failed.length > 0 ? ` ${failed.length} setting(s) could not be changed; see the Iceberg output.` : '';
  const reload = 'Reload Window';
  const uninstall = 'Uninstall Bear in Mind';
  const choice = await vscode.window.showInformationMessage(
    `Bear in Mind is disconnected and back to its defaults.${note} Reload so Copilot Chat applies the ` +
      'restored telemetry settings, or uninstall to remove the extension as well.',
    reload,
    uninstall
  );
  if (choice === uninstall) {
    const id = context.extension?.id ?? 'obrocki.bear-in-mind';
    try {
      await vscode.commands.executeCommand('workbench.extensions.uninstallExtension', id);
    } catch (err) {
      output.appendLine(`  could not uninstall ${id}: ${String(err)}`);
      await vscode.commands.executeCommand('workbench.extensions.search', `@installed ${id}`);
      return;
    }
  }
  if (choice) {
    await vscode.commands.executeCommand('workbench.action.reloadWindow');
  }
}

async function promptReload(message: string): Promise<void> {
  const reload = 'Reload Window';
  if ((await vscode.window.showInformationMessage(message, reload)) === reload) {
    await vscode.commands.executeCommand('workbench.action.reloadWindow');
  }
}

function isInside(dir: string, file: string): boolean {
  const relative = path.relative(path.resolve(dir), path.resolve(file));
  return !!relative && !relative.startsWith('..') && !path.isAbsolute(relative);
}

function showDiagnostics(otel: OtelWatcher, meter: TokenMeter, output: vscode.OutputChannel, session?: SessionComparison): void {
  const feed = otel.health();
  const usage = meter.snapshot();
  const drift = usage.drift;

  output.appendLine('');
  output.appendLine('── Telemetry diagnostics ──────────────────────────────');
  output.appendLine(`  reading telemetry   ${feed.watching ? 'yes' : 'no'}`);
  output.appendLine(`  copilot otel        ${feed.copilotOtelEnabled ? 'enabled' : 'disabled'}`);
  output.appendLine(`  file feed           ${feed.jsonlPath ?? '(not configured)'}`);
  output.appendLine(`  trace store         ${feed.sqlitePath ?? '(not found)'}`);
  // Already redacted by `health()`, which is the single place that touches the
  // raw value.
  output.appendLine(`  otlp endpoint       ${feed.otlpEndpoint ?? '(none)'}`);
  output.appendLine(
    `  records             ${feed.records.metrics} metric exports · ${feed.records.logs} events · ` +
      `${feed.records.spans} span records (legacy exports may be empty) · ${feed.records.unknown} unknown · ${feed.records.malformed} malformed`
  );
  output.appendLine(
    `  last record         ${feed.lastRecordAtMs ? new Date(feed.lastRecordAtMs).toISOString() : 'never'}`
  );
  output.appendLine(`  charging source     ${usage.source}`);
  output.appendLine(`  meter since         ${new Date(meter.since).toISOString()}`);
  output.appendLine(`  local scope         observed sessions/workspaces, not selected chat or billing period`);
  output.appendLine(`  local totals        ${usage.input} input / ${usage.output} output tokens`);
  output.appendLine(`  reported credits    ${usage.credits > 0 ? usage.credits : 'not reported'} (local transcripts)`);
  output.appendLine(`  local budget        ${usage.total} counted / ${usage.budget} tokens (visual target only)`);
  output.appendLine(`  manual / legacy     ${usage.manualTokens} explicit / ${usage.legacyTokens} excluded old estimates`);
  if (session) {
    output.appendLine(`  comparison session  ${session.name ? `${session.name} · ` : ''}${session.sessionId} (${session.pinned ? 'pinned' : 'latest observed'}, not active-chat API)`);
    output.appendLine(`  session cost        ${session.transcript?.credits ?? 'not reported'} transcript credits`);
    output.appendLine(`  trace call credits  ${session.trace?.credits ?? 'not reported'} across ${session.trace?.creditCalls ?? 0}/${session.trace?.llmCalls ?? 0} calls`);
    output.appendLine(`  trace session tokens ${session.trace?.inputTokens ?? 'unknown'} input / ${session.trace?.outputTokens ?? 'unknown'} output`);
    output.appendLine(`  session work        ${session.work ?? 'not reported'} (agent span git attributes)`);
    output.appendLine(`  session user(s)     ${session.trace?.user ?? 'not reported'} (user.name on agent spans)`);
  }
  const spans = otel.spanDigest;
  output.appendLine(
    `  retained trace calls ${spans.creditCalls}/${spans.chatCalls} reported ${spans.credits} credits; ` +
    `${spans.sessionlessCalls} calls without a session ID; ${spans.toolFailures}/${spans.toolStatusCalls} tool spans failed`
  );
  const userCalls = spans.byUser.reduce((sum, row) => sum + (row.key === null ? 0 : row.calls), 0);
  output.appendLine(
    `  identity capture    ${feed.identityCapture ? 'requested' : 'off'} · ${userCalls}/${spans.chatCalls} retained calls ` +
    `attributed to a user.name across ${spans.byUser.filter((row) => row.key !== null).length} user(s)` +
    (feed.identityCapture ? '' : ' — turn on github.copilot.chat.otel.captureIdentity (VS Code 1.140+) to attribute calls')
  );
  output.appendLine(`  ice gauge           ${usage.basis}: ${iceReadout(usage)}`);
  if (usage.context) {
    output.appendLine(
      `  latest prompt       ${usage.context.used} / ${usage.context.limit} max_prompt_tokens · ` +
      `${usage.context.model ?? 'unknown model'} · ${new Date(usage.context.atMs).toISOString()} (any session)`
    );
  }
  const observed = otel.rollup.tokenTotals();
  output.appendLine(`  feed with history   ${observed.input} input / ${observed.output} output tokens`);
  output.appendLine('  billing allowance   not read; tokens are not credits');
  output.appendLine(
    `  reconciliation      ${
      drift.pending
        ? 'pending — waiting for observations from both sources'
        : `metrics ${drift.otelObserved} vs spans ${drift.spanObserved} tokens ` +
          `(${drift.deltaTokens >= 0 ? '+' : '-'}${Math.abs(drift.deltaTokens)}, ` +
          `${drift.deltaPercent.toFixed(2)}%) — ${drift.agreeing ? 'agreeing' : 'DIVERGING'}`
    }`
  );
  for (const note of feed.notes) {
    output.appendLine(`  note                ${note}`);
  }
  output.appendLine('───────────────────────────────────────────────────────');
  output.show(true);
}

/** The view and command ids an extension claims, read from its manifest. */
interface ContributionPoints {
  views: Set<string>;
  commands: Set<string>;
}

function contributionsOf(extension: vscode.Extension<unknown> | undefined): ContributionPoints {
  const contributes = extension?.packageJSON?.contributes;
  const views = new Set<string>();
  // `contributes.views` maps a container id to an array of view descriptors.
  for (const container of Object.values(contributes?.views ?? {})) {
    if (!Array.isArray(container)) {
      continue;
    }
    for (const view of container) {
      if (typeof view?.id === 'string') {
        views.add(view.id);
      }
    }
  }
  const commands = new Set<string>();
  const declared = contributes?.commands;
  if (Array.isArray(declared)) {
    for (const command of declared) {
      if (typeof command?.command === 'string') {
        commands.add(command.command);
      }
    }
  }
  return { views, commands };
}

function sharesAny(ours: Set<string>, theirs: Set<string>): boolean {
  for (const value of ours) {
    if (theirs.has(value)) {
      return true;
    }
  }
  return false;
}

/** Match contributed IDs, not names: renamed installs can still claim the same commands and views. */
function findConflictingInstall(
  self: vscode.Extension<unknown> | undefined
): vscode.Extension<unknown> | undefined {
  // Without our own identity we cannot tell another copy from ourselves, and a
  // false positive would disable the extension outright. Assume no conflict.
  if (!self?.id) {
    return undefined;
  }
  const ours = contributionsOf(self);
  const mine = self.id.toLowerCase();
  const installed = vscode.extensions?.all ?? [];
  if (ours.views.size === 0 && ours.commands.size === 0) {
    // Our own manifest is unreadable, so fall back to the extension name — but
    // taken from our own id rather than written in, so a rename cannot blind it.
    const ourName = mine.split('.')[1];
    if (!ourName) {
      return undefined;
    }
    return installed.find((o) => {
      const id = o?.id?.toLowerCase();
      return !!id && id !== mine && id.split('.')[1] === ourName;
    });
  }
  return installed.find((other) => {
    const id = other?.id?.toLowerCase();
    if (!id || id === mine) {
      return false;
    }
    const theirs = contributionsOf(other);
    return sharesAny(ours.views, theirs.views) || sharesAny(ours.commands, theirs.commands);
  });
}

/**
 * Registers nothing and explains why. Better a working old copy and one clear
 * message than two half-broken copies splitting the token count between them.
 */
function standDown(
  context: vscode.ExtensionContext,
  conflict: vscode.Extension<unknown>
): IcebergApi {
  const other = conflict.id;
  const emitter = new vscode.EventEmitter<UsageSnapshot>();
  context.subscriptions.push(emitter);

  const uninstall = `Uninstall ${other}`;
  void vscode.window
    .showErrorMessage(
      `Bear in Mind is installed twice — as ${context.extension?.id ?? 'this copy'} and as ${other}. ` +
        'Both claim the same view and commands, so the menus are duplicated and the ' +
        'token count is split between them. Uninstall the older copy and reload.',
      uninstall,
      'Show Extensions'
    )
    .then(async (choice) => {
      if (choice === uninstall) {
        try {
          await vscode.commands.executeCommand('workbench.extensions.uninstallExtension', other);
          const reload = 'Reload Window';
          const picked = await vscode.window.showInformationMessage(
            `Removed ${other}. Reload to finish.`,
            reload
          );
          if (picked === reload) {
            await vscode.commands.executeCommand('workbench.action.reloadWindow');
          }
          return;
        } catch {
          // Fall through to the manual route below.
        }
      }
      if (choice) {
        await vscode.commands.executeCommand('workbench.extensions.search', '@installed iceberg');
      }
    });

  return {
    reportUsage: () => undefined,
    getUsage: () => ({
      input: 0,
      output: 0,
      total: 0,
      budget: 0,
      health: 1,
      requests: 0,
      credits: 0,
      manualTokens: 0,
      legacyTokens: 0,
      meltdownDemo: false,
      bearName: '',
      animate: false,
      pixelScale: 0,
      source: 'none',
      basis: 'unavailable',
      drift: {
        otelObserved: 0,
        spanObserved: 0,
        deltaTokens: 0,
        deltaPercent: 0,
        agreeing: true,
        pending: true
      }
    }),
    onDidChangeUsage: emitter.event
  };
}

/**
 * `@iceberg` uses the same telemetry as other calls; tokenizing visible text
 * would miss system/tool/reasoning usage and double-count the observed call.
 */
function registerChatParticipant(context: vscode.ExtensionContext, meter: TokenMeter): void {
  if (!vscode.chat?.createChatParticipant) {
    return;
  }
  try {
    const participant = vscode.chat.createChatParticipant(
      'iceberg.bear',
      async (request, _chatContext, stream, token) => {
        const s = meter.snapshot();

        const messages = [
          vscode.LanguageModelChatMessage.User(
            `You are ${s.bearName}, a laconic pixel-art polar bear standing on a shrinking iceberg. ` +
              `The iceberg shows ${iceReadout(s)}. This is not a Copilot credit balance or spending cap. ` +
              `Answer the user helpfully in at most ` +
              `4 sentences, and work in one dry remark about the ice.`
          ),
          vscode.LanguageModelChatMessage.User(request.prompt)
        ];

        try {
          const response = await request.model.sendRequest(messages, {}, token);
          for await (const chunk of response.text) {
            stream.markdown(chunk);
          }
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          stream.markdown(`The bear could not reach the model (${message}).`);
        }

        stream.markdown(
          '\n\n---\nUsage is recorded from Copilot telemetry when available, not estimated from visible text.'
        );
        stream.button({ command: 'iceberg.open', title: 'Watch the iceberg' });
        return {};
      }
    );
    participant.iconPath = vscode.Uri.joinPath(context.extensionUri, 'media', 'bear.svg');
    context.subscriptions.push(participant);
  } catch {
    // Chat isn't available in this VS Code build — the rest still works.
  }
}

function iceReadout(s: UsageSnapshot): string {
  const pct = Math.round(s.health * 100);
  if (s.basis === 'unavailable') {
    return 'ice unscaled: no reported prompt limit or user-selected target; not an environmental measurement';
  }
  if (s.basis === 'demo') {
    return `${pct}% demo ice remaining (synthetic animation, no usage recorded)`;
  }
  return s.basis === 'context' && s.context
    ? `${pct}% latest prompt allowance free (used ${s.context.used.toLocaleString('en-US')} / limit ${s.context.limit.toLocaleString('en-US')} tokens; session ${s.context.sessionId ?? 'not reported'})`
    : `${pct}% local token budget remaining (counted ${s.total.toLocaleString('en-US')} / target ${s.budget.toLocaleString('en-US')} tokens; visual target, not a Copilot spending cap)`;
}

function fmt(n: number): string {
  if (n >= 1_000_000) {
    return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M`;
  }
  if (n >= 10_000) {
    return `${Math.round(n / 1000)}k`;
  }
  return n.toLocaleString('en-US');
}

function moodLine(health: number): string {
  if (health > 0.85) {
    return 'is doing laps on a very large iceberg.';
  }
  if (health > 0.6) {
    return 'has plenty of room to roam.';
  }
  if (health > 0.35) {
    return 'is starting to pace in circles.';
  }
  if (health > 0.15) {
    return 'is watching the edges nervously.';
  }
  if (health > 0.02) {
    return 'can barely turn around up there.';
  }
  return 'is treading water.';
}
