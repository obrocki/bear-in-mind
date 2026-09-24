import * as vscode from 'vscode';
import type { DashboardSnapshot } from './otelSummary';

/** Produces the current snapshot on demand, so the host owns no state. */
export type SnapshotSource = () => DashboardSnapshot;

/** Shared plumbing for the dashboard, in an editor tab or in the sidebar. */
class DashboardHost implements vscode.Disposable {
  private readonly disposables: vscode.Disposable[] = [];

  constructor(
    private readonly webview: vscode.Webview,
    private readonly extensionUri: vscode.Uri,
    private readonly snapshot: SnapshotSource,
    onChange: vscode.Event<unknown>
  ) {
    webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'media')]
    };
    webview.html = this.html();

    this.disposables.push(
      onChange(() => this.push()),
      webview.onDidReceiveMessage((msg: { type?: string }) => {
        switch (msg?.type) {
          case 'ready':
            this.push();
            break;
          case 'connect':
            void vscode.commands.executeCommand('iceberg.connectTelemetry');
            break;
          case 'diagnostics':
            void vscode.commands.executeCommand('iceberg.telemetryDiagnostics');
            break;
          case 'session':
            void vscode.commands.executeCommand('iceberg.selectSession');
            break;
          default:
            break;
        }
      })
    );
  }

  push(): void {
    void this.webview.postMessage({ type: 'snapshot', snapshot: this.snapshot() });
  }

  private uri(...parts: string[]): vscode.Uri {
    return this.webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, ...parts));
  }

  private html(): string {
    const nonce = makeNonce();
    const script = this.uri('media', 'dashboard.js');
    const style = this.uri('media', 'dashboard.css');
    const csp = [
      `default-src 'none'`,
      `img-src ${this.webview.cspSource} data:`,
      `style-src ${this.webview.cspSource} 'unsafe-inline'`,
      `script-src 'nonce-${nonce}'`,
      `font-src ${this.webview.cspSource}`
    ].join('; ');

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta http-equiv="Content-Security-Policy" content="${csp}" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<link href="${style}" rel="stylesheet" />
<title>Copilot cost, speed and quality</title>
</head>
<body>
  <div id="banner"></div>
  <div class="sections" id="sections"></div>
  <footer>
    <p class="provenance" id="provenance"></p>
  </footer>

  <script nonce="${nonce}" src="${script}"></script>
</body>
</html>`;
  }

  dispose(): void {
    this.disposables.forEach((d) => d.dispose());
  }
}

export class DashboardViewProvider implements vscode.WebviewViewProvider {
  static readonly viewType = 'iceberg.dashboard';
  private host: DashboardHost | undefined;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly snapshot: SnapshotSource,
    private readonly onChange: vscode.Event<unknown>
  ) {}

  resolveWebviewView(view: vscode.WebviewView): void {
    const host = new DashboardHost(view.webview, this.extensionUri, this.snapshot, this.onChange);
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

export function openDashboardPanel(
  extensionUri: vscode.Uri,
  snapshot: SnapshotSource,
  onChange: vscode.Event<unknown>
): void {
  if (panel) {
    panel.reveal(panel.viewColumn ?? vscode.ViewColumn.Active);
    return;
  }
  panel = vscode.window.createWebviewPanel(
    'iceberg.dashboardPanel',
    'Copilot: Cost, Speed, Quality',
    { viewColumn: vscode.ViewColumn.Active },
    {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'media')]
    }
  );
  panel.iconPath = vscode.Uri.joinPath(extensionUri, 'media', 'bear.svg');
  const host = new DashboardHost(panel.webview, extensionUri, snapshot, onChange);
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
