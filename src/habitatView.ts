import * as vscode from 'vscode';
import type { TokenMeter, UsageSnapshot } from './tokenMeter';

/** Shared HTML/plumbing for both the sidebar view and the editor-tab panel. */
class HabitatHost implements vscode.Disposable {
  private readonly disposables: vscode.Disposable[] = [];

  constructor(
    private readonly webview: vscode.Webview,
    private readonly extensionUri: vscode.Uri,
    meter: TokenMeter,
    private readonly compact: boolean
  ) {
    webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'media')]
    };
    webview.html = this.html();

    this.disposables.push(
      meter.onDidChange((s) => this.push(s)),
      webview.onDidReceiveMessage((msg: { type?: string }) => {
        switch (msg?.type) {
          case 'ready':
            this.push(meter.snapshot());
            break;
          case 'dashboard':
            void vscode.commands.executeCommand('iceberg.openDashboard');
            break;
          default:
            break;
        }
      })
    );
    this.push(meter.snapshot());
  }

  push(state: UsageSnapshot): void {
    void this.webview.postMessage({ type: 'state', state });
  }

  private uri(...parts: string[]): vscode.Uri {
    return this.webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, ...parts));
  }

  private html(): string {
    const nonce = makeNonce();
    const script = this.uri('media', 'main.js');
    const style = this.uri('media', 'style.css');
    const csp = [
      `default-src 'none'`,
      `img-src ${this.webview.cspSource} data:`,
      `style-src ${this.webview.cspSource} 'unsafe-inline'`,
      `script-src 'nonce-${nonce}'`,
      `font-src ${this.webview.cspSource}`
    ].join('; ');

    return `<!DOCTYPE html>
<html lang="en" data-compact="${this.compact}">
<head>
<meta charset="UTF-8" />
<meta http-equiv="Content-Security-Policy" content="${csp}" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<link href="${style}" rel="stylesheet" />
<title>Iceberg</title>
</head>
<body>
  <div id="stage">
    <canvas id="scene"></canvas>
    <div id="melted" class="badge" hidden>THE ICE IS GONE</div>
  </div>
  <div id="hud">
    <div class="row">
      <span id="bearName" class="name">Nanuq</span>
      <span id="pct" class="pct">100%</span>
    </div>
    <div class="bar" title="Ice remaining"><div id="fill"></div></div>
    <div class="row sub">
      <span id="basis">local budget remaining</span>
      <span id="split">local in 0 · out 0</span>
    </div>
    <div class="row sub">
      <span id="tokens">Waiting for local usage…</span>
    </div>
    <div class="row sub">
      <span id="source" class="source" title="Where the numbers come from">—</span>
      <button id="btnDashboard" type="button" title="Open the cost, speed and quality dashboard">Dashboard →</button>
    </div>
    <p class="note">Local token usage, not your Copilot credit balance. The budget is a visual target, not a spending cap.</p>
  </div>
  <script nonce="${nonce}" src="${script}"></script>
</body>
</html>`;
  }

  dispose(): void {
    this.disposables.forEach((d) => d.dispose());
  }
}

export class IcebergViewProvider implements vscode.WebviewViewProvider {
  static readonly viewType = 'iceberg.habitat';
  private host: HabitatHost | undefined;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly meter: TokenMeter
  ) {}

  resolveWebviewView(view: vscode.WebviewView): void {
    view.webview.options = { enableScripts: true };
    const host = new HabitatHost(view.webview, this.extensionUri, this.meter, true);
    this.host = host;
    view.onDidDispose(() => {
      host.dispose();
      if (this.host === host) {
        this.host = undefined;
      }
    });
  }

  dispose(): void {
    this.host?.dispose();
  }
}

let panel: vscode.WebviewPanel | undefined;

export function openHabitatPanel(extensionUri: vscode.Uri, meter: TokenMeter): void {
  if (panel) {
    panel.reveal(panel.viewColumn ?? vscode.ViewColumn.Active);
    return;
  }
  panel = vscode.window.createWebviewPanel(
    'iceberg.habitatPanel',
    'Iceberg',
    { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
    {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'media')]
    }
  );
  panel.iconPath = vscode.Uri.joinPath(extensionUri, 'media', 'bear.svg');
  const host = new HabitatHost(panel.webview, extensionUri, meter, false);
  panel.onDidDispose(() => {
    host.dispose();
    panel = undefined;
  });
}

function makeNonce(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let out = '';
  for (let i = 0; i < 32; i++) {
    out += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return out;
}
