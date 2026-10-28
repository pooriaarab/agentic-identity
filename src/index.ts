export { VERSION } from "./version.js";
export {
  ACTIONS,
  MAX_CHAIN_DEPTH,
  PRINCIPAL_KINDS,
  auditEntry,
  hasScope,
  intersectScopes,
  isMachineMade,
  parseScope,
  resolveChain,
  scopeCovers,
} from "./core/principals.js";
export type {
  Action,
  AuditEntry,
  ChainFailure,
  ChainStep,
  Principal,
  PrincipalContext,
  PrincipalKind,
  Resolution,
  Scope,
} from "./core/principals.js";
