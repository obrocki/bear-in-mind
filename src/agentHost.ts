import * as path from 'path';

/**
 * VS Code's Copilot harness runs in the Agent Host, a separate process with its
 * own OTel pipeline (`chat.agentHost.otel.*`, VS Code 1.141+). Pure helpers so
 * the connect decision and store location can be tested without a VS Code host.
 */

export const AGENT_HOST_SECTION = 'chat.agentHost.otel';
/** Relative to `chat.agentHost.otel`. Persists Agent Host spans to a local SQLite store. */
export const AGENT_HOST_DB_KEY = 'dbSpanExporter.enabled';

/**
 * `<userData>/agent-host/otel/agent-host-traces.db`. Extension global storage is
 * `<userData>/User/globalStorage/<extension>`, so this follows portable and
 * custom `--user-data-dir` installs without guessing a product folder.
 */
export function agentHostTracesDbPath(globalStorageFsPath: string): string {
  const userData = path.dirname(path.dirname(path.dirname(globalStorageFsPath)));
  return path.join(userData, 'agent-host', 'otel', 'agent-host-traces.db');
}

export interface AgentHostExporter {
  /** `chat.agentHost.otel.otlpEndpoint`, or an inherited `OTEL_EXPORTER_OTLP_ENDPOINT`. */
  endpoint?: string;
  /** `chat.agentHost.otel.exporterType`; `otlp-http` when unset. */
  exporterType?: string;
  /** Managed `otlpProtocol`, `OTEL_EXPORTER_OTLP_PROTOCOL` or `COPILOT_OTEL_PROTOCOL`; `http/json` when unset. */
  protocol?: string;
}

/**
 * Whether DB mode leaves an external trace destination intact. In DB mode the
 * Agent Host receives traces over a loopback and forwards only OTLP/HTTP JSON
 * (and file/console); protobuf and gRPC traces stay in SQLite.
 */
export function agentHostDbKeepsExporter({ endpoint, exporterType, protocol }: AgentHostExporter): boolean {
  if (!endpoint?.trim()) {
    return true;
  }
  const type = (exporterType || 'otlp-http').trim().toLowerCase();
  if (type === 'file' || type === 'console') {
    return true;
  }
  const wire = (protocol || '').trim().toLowerCase();
  return type === 'otlp-http' && wire !== 'http/protobuf' && wire !== 'grpc' && wire !== 'http/grpc';
}
