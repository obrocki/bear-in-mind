import * as vscode from 'vscode';
import { ChatUsageWatcher } from './chatWatcher';
import { IcebergViewProvider, openHabitatPanel } from './habitatView';
import { TokenMeter, countTokens, type UsageSnapshot } from './tokenMeter';

/** Public API other extensions can use: `exports.reportUsage({ input, output })`. */
export interface IcebergApi {
  reportUsage(usage: { input?: number; output?: number }): void;
  getUsage(): UsageSnapshot;
  onDidChangeUsage: vscode.Event<UsageSnapshot>;
}

export function activate(context: vscode.ExtensionContext): IcebergApi {
  const meter = new TokenMeter(context.globalState);
  context.subscriptions.push(meter);

  const output = vscode.window.createOutputChannel('Iceberg');
  context.subscriptions.push(output);

  // Automatic metering: VS Code records exact per-request token counts in its
  // chat transcripts, so regular Copilot Chat traffic melts the iceberg too.
  const watcher = new ChatUsageWatcher(
    context,
    (delta) => meter.report(delta.input, delta.output, delta.requests, delta.credits),
    (message) => output.appendLine(`[${new Date().toISOString()}] ${message}`)
  );
  context.subscriptions.push(watcher);
  watcher.start();
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (
        e.affectsConfiguration('iceberg.trackCopilotChat') ||
        e.affectsConfiguration('iceberg.chatPollIntervalMs')
      ) {
        watcher.reconfigure();
      }
    })
  );

  const provider = new IcebergViewProvider(context.extensionUri, meter);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(IcebergViewProvider.viewType, provider, {
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
        `**Iceberg** — ${pct}% ice remaining`,
        '',
        `- Used: \`${fmt(s.total)}\` / \`${fmt(s.budget)}\` tokens`,
        `- Input: \`${fmt(s.input)}\` · Output: \`${fmt(s.output)}\``,
          `- Requests counted: \`${s.requests}\`` +
            (s.credits > 0 ? ` · Credits: \`${s.credits.toFixed(1)}\`` : ''),
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

    vscode.commands.registerCommand(
      'iceberg.report',
      (usage: { input?: number; output?: number } | number) => {
        if (typeof usage === 'number') {
          meter.report(usage, 0);
        } else {
          meter.report(usage?.input ?? 0, usage?.output ?? 0);
        }
      }
    ),

    vscode.commands.registerCommand('iceberg.addTokens', async () => {
      const raw = await vscode.window.showInputBox({
        title: 'Add tokens to the meter',
        prompt: 'Number of tokens to burn (use "1200/350" for input/output)',
        placeHolder: 'e.g. 2500 or 2000/500',
        validateInput: (v) => (parseUsage(v) ? undefined : 'Enter a number, or input/output')
      });
      const parsed = raw ? parseUsage(raw) : undefined;
      if (parsed) {
        meter.report(parsed.input, parsed.output);
      }
    }),

    vscode.commands.registerCommand('iceberg.countSelection', async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) {
        void vscode.window.showWarningMessage('Iceberg: open a file and select some text first.');
        return;
      }
      const text = editor.selection.isEmpty
        ? editor.document.getText()
        : editor.document.getText(editor.selection);
      const n = await countTokens(text);
      meter.report(n, 0);
      void vscode.window.showInformationMessage(`Iceberg: burned ${fmt(n)} prompt tokens.`);
    }),

    vscode.commands.registerCommand('iceberg.setBudget', async () => {
      const current = meter.budget;
      const raw = await vscode.window.showInputBox({
        title: 'Iceberg token budget',
        value: String(current),
        prompt: 'Total tokens that melt the iceberg completely',
        validateInput: (v) => {
          const n = Number(v.replace(/[_,\s]/g, ''));
          return Number.isFinite(n) && n >= 1000 ? undefined : 'Enter a number >= 1000';
        }
      });
      if (raw === undefined) {
        return;
      }
      const n = Math.round(Number(raw.replace(/[_,\s]/g, '')));
      await vscode.workspace
        .getConfiguration('iceberg')
        .update('tokenBudget', n, vscode.ConfigurationTarget.Global);
    }),

    vscode.commands.registerCommand('iceberg.reset', () => {
      meter.reset();
      watcher.rebaseline();
      void vscode.window.showInformationMessage('Iceberg: refrozen. The bear is pleased. 🐻‍❄️');
    }),

    vscode.commands.registerCommand('iceberg.showStats', async () => {
      const s = meter.snapshot();
      const tracking = watcher.enabled ? 'auto-tracking Copilot Chat' : 'auto-tracking off';
      const pick = await vscode.window.showInformationMessage(
        `${Math.round(s.health * 100)}% ice left — ${fmt(s.total)} / ${fmt(s.budget)} tokens ` +
          `(in ${fmt(s.input)}, out ${fmt(s.output)}, ${s.requests} requests` +
          `${s.credits > 0 ? `, ${s.credits.toFixed(1)} credits` : ''}) · ${tracking}.`,
        'Open Habitat',
        'Refreeze'
      );
      if (pick === 'Open Habitat') {
        openHabitatPanel(context.extensionUri, meter);
      } else if (pick === 'Refreeze') {
        meter.reset();
        watcher.rebaseline();
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

  return {
    reportUsage: (u) => meter.report(u?.input ?? 0, u?.output ?? 0),
    getUsage: () => meter.snapshot(),
    onDidChangeUsage: meter.onDidChange
  };
}

export function deactivate(): void {
  /* disposables handle cleanup */
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
    participant.iconPath = vscode.Uri.joinPath(context.extensionUri, 'media', 'iceberg.svg');
    context.subscriptions.push(participant);
  } catch {
    // Chat isn't available in this VS Code build — the rest still works.
  }
}

function parseUsage(raw: string): { input: number; output: number } | undefined {
  const cleaned = raw.replace(/[_,\s]/g, '');
  if (!cleaned) {
    return undefined;
  }
  const parts = cleaned.split('/');
  const input = Number(parts[0]);
  const output = parts.length > 1 ? Number(parts[1]) : 0;
  if (!Number.isFinite(input) || input < 0 || !Number.isFinite(output) || output < 0) {
    return undefined;
  }
  if (input === 0 && output === 0) {
    return undefined;
  }
  return { input: Math.round(input), output: Math.round(output) };
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
  return 'is treading water. Consider refreezing.';
}
