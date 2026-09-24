import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { createIcebergApi, type IcebergApi } from './api';
import { pickBearName } from './bearNames';
import { ChatUsageWatcher } from './chatWatcher';
import { DashboardViewProvider, openDashboardPanel } from './dashboardView';
import { IcebergViewProvider, openHabitatPanel } from './habitatView';
import { OtelWatcher } from './otelWatcher';
import { buildSnapshot, redactUrl, type DashboardSnapshot } from './otelSummary';
import { TokenMeter, countTokens, type UsageSnapshot } from './tokenMeter';

export type { IcebergApi, UsageReport, UsageSnapshot } from './api';

const OTEL_SECTION = 'github.copilot.chat.otel';

export function activate(context: vscode.ExtensionContext): IcebergApi {
  const conflict = findConflictingInstall(context.extension);
  if (conflict) {
    return standDown(context, conflict);
  }

  const meter = new TokenMeter(context.globalState);
  const api = createIcebergApi(meter);
  context.subscriptions.push(meter);

  const output = vscode.window.createOutputChannel('Iceberg');
  context.subscriptions.push(output);
  const log = (message: string) => output.appendLine(`[${new Date().toISOString()}] ${message}`);

  // Watchers observe the same traffic; the meter reconciles their cumulative totals.
  const watcher = new ChatUsageWatcher(
    context,
    (delta) => meter.observe('transcripts', delta.input, delta.output, delta.requests, delta.credits),
    log
  );
  context.subscriptions.push(watcher);
  watcher.start();

  const otel = new OtelWatcher(
    context,
    (delta) => meter.observe('otel', delta.input, delta.output, delta.requests),
    log
  );
  context.subscriptions.push(otel);
  otel.start();

  // The ice tracks how full the model's context window is whenever telemetry
  // reports it, and falls back to cumulative burn against the budget when it
  // does not. Pushing it on every poll keeps the scene live, and keeps
  // telemetry authoritative through idle spells when no tokens are moving.
  context.subscriptions.push(
    otel.onDidScan(() => {
      meter.setContext(otel.spanDigest.context);
      meter.noteOtelAlive(otel.producing);
    })
  );

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
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
      health: usage.health,
      totals: { input: usage.input, output: usage.output, credits: usage.credits },
      source: usage.source,
      basis: usage.basis,
      context: usage.context,
      drift: usage.drift
    });
  };

  // The dashboard has to follow the telemetry as well as the meter: quality and
  // speed signals move without any token being charged, so a meter-only
  // subscription would leave those two sections stale.
  const changed = new vscode.EventEmitter<void>();
  context.subscriptions.push(
    changed,
    meter.onDidChange(() => changed.fire()),
    otel.onDidScan(() => changed.fire())
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
    status.text = `$(snowflake) ${pct}%`;
    status.tooltip = new vscode.MarkdownString(
      [
        s.basis === 'context' && s.context
          ? `**Bear in Mind** — ${pct}% of the context window free`
          : `**Bear in Mind** — ${pct}% ice remaining`,
        '',
        ...(s.basis === 'context' && s.context
          ? [`- Context: \`${fmt(s.context.used)}\` / \`${fmt(s.context.limit)}\`${s.context.model ? ` (${s.context.model})` : ''}`]
          : []),
        `- Used: \`${fmt(s.total)}\` / \`${fmt(s.budget)}\` tokens`,
        `- Input: \`${fmt(s.input)}\` · Output: \`${fmt(s.output)}\``,
        `- Requests counted: \`${s.requests}\`` +
          (s.credits > 0 ? ` · Credits: \`${s.credits.toFixed(1)}\`` : ''),
        `- Source: ${s.source === 'otel' ? 'OpenTelemetry' : 'chat transcripts'}`,
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

    vscode.commands.registerCommand('iceberg.connectTelemetry', () => connectTelemetry(otel, output)),

    vscode.commands.registerCommand('iceberg.telemetryDiagnostics', () => showDiagnostics(otel, meter, output)),

    vscode.commands.registerCommand('iceberg.showStats', async () => {
      const s = meter.snapshot();
      const source = s.source === 'otel' ? 'metered by OpenTelemetry' : 'metered from chat transcripts';
      const pick = await vscode.window.showInformationMessage(
        `${Math.round(s.health * 100)}% ice left — ${fmt(s.total)} / ${fmt(s.budget)} tokens ` +
          `(in ${fmt(s.input)}, out ${fmt(s.output)}, ${s.requests} requests` +
          `${s.credits > 0 ? `, ${s.credits.toFixed(1)} credits` : ''}) · ${source}.`,
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

export function deactivate(): void {
  /* disposables handle cleanup */
}

/** Trace storage is additive; the file feed replaces OTLP, so ask before changing it. */
async function connectTelemetry(otel: OtelWatcher, output: vscode.OutputChannel): Promise<void> {
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
  const traceStoreAvailable = config.inspect('dbSpanExporter')?.defaultValue !== undefined;

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

  const choices = traceStoreAvailable ? [traceStore, both, fileFeed] : [fileFeed];
  const placeHolder = !traceStoreAvailable
    ? 'This Copilot Chat has no local trace store, so the file feed is the only source'
    : collectorInUse
      ? `An OTLP endpoint is configured (${endpointLabel}) — only the trace store leaves it intact`
      : 'Everything stays on this machine; nothing is sent anywhere';

  const picked = await vscode.window.showQuickPick(choices, {
    title: 'Connect Copilot telemetry to Bear in Mind',
    placeHolder
  });
  if (!picked) {
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

  const wanted: Array<[string, unknown]> = [['enabled', true]];
  if (picked.id === 'sqlite' || picked.id === 'both') {
    wanted.push(['dbSpanExporter', true]);
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

  const applied: string[] = [];
  const failed: string[] = [];
  for (const [key, value] of wanted) {
    // A setting this build of Copilot Chat does not register cannot be written —
    // `update` rejects. Writing them one at a time, and checking first, means one
    // unknown key cannot abort the rest of the setup.
    const known = config.inspect(key);
    if (!known || known.defaultValue === undefined) {
      failed.push(key);
      output.appendLine(`[iceberg] ${OTEL_SECTION}.${key} is not a setting in this VS Code build; skipped.`);
      continue;
    }
    try {
      await config.update(key, value, vscode.ConfigurationTarget.Global);
      applied.push(key);
    } catch (err) {
      failed.push(key);
      output.appendLine(`[iceberg] could not set ${OTEL_SECTION}.${key}: ${String(err)}`);
    }
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

function showDiagnostics(otel: OtelWatcher, meter: TokenMeter, output: vscode.OutputChannel): void {
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
      `${feed.records.spans} spans skipped · ${feed.records.unknown} unknown · ${feed.records.malformed} malformed`
  );
  output.appendLine(
    `  last record         ${feed.lastRecordAtMs ? new Date(feed.lastRecordAtMs).toISOString() : 'never'}`
  );
  output.appendLine(`  charging source     ${usage.source}`);
  output.appendLine(
    `  reconciliation      ${
      drift.pending
        ? 'pending — the two sources have not overlapped yet'
        : `otel ${fmt(drift.otelObserved)} vs transcripts ${fmt(drift.transcriptObserved)} ` +
          `(${drift.deltaTokens >= 0 ? '+' : '-'}${fmt(Math.abs(drift.deltaTokens))}, ` +
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
      meltdownDemo: false,
      bearName: '',
      animate: false,
      pixelScale: 0,
      source: 'transcripts',
      basis: 'budget',
      drift: {
        otelObserved: 0,
        transcriptObserved: 0,
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
 * `@iceberg` chat participant. Anything routed through it is metered with the
 * model's own tokenizer, so the iceberg melts by a real amount.
 */
function registerChatParticipant(context: vscode.ExtensionContext, meter: TokenMeter): void {
  if (!vscode.chat?.createChatParticipant) {
    return;
  }
  try {
    const participant = vscode.chat.createChatParticipant(
      'iceberg.bear',
      async (request, chatContext, stream, token) => {
        const s = meter.snapshot();
        const pct = Math.round(s.health * 100);

        const history = chatContext.history
          .map((h) => ('prompt' in h ? h.prompt : ''))
          .join('\n');
        const promptTokens = await countTokens(request.prompt + '\n' + history, request.model);

        const messages = [
          vscode.LanguageModelChatMessage.User(
            `You are ${s.bearName}, a laconic pixel-art polar bear standing on a shrinking iceberg. ` +
              `The iceberg represents the user's remaining LLM token budget: ${pct}% ice left ` +
              `(${s.total} of ${s.budget} tokens burned). Answer the user helpfully in at most ` +
              `4 sentences, and work in one dry remark about the ice.`
          ),
          vscode.LanguageModelChatMessage.User(request.prompt)
        ];

        let reply = '';
        try {
          const response = await request.model.sendRequest(messages, {}, token);
          for await (const chunk of response.text) {
            reply += chunk;
            stream.markdown(chunk);
          }
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          reply = `The bear could not reach the model (${message}).`;
          stream.markdown(reply);
        }

        const replyTokens = await countTokens(reply, request.model);
        meter.report(promptTokens, replyTokens);

        const after = meter.snapshot();
        stream.markdown(
          `\n\n---\n\`${fmt(promptTokens)}\` in · \`${fmt(replyTokens)}\` out — ` +
            `**${Math.round(after.health * 100)}%** ice left.`
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
