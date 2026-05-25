export type RCAStatus = 'open' | 'in_progress' | 'rca_done' | 'closed';
export type RCASeverity = 'sev1' | 'sev2' | 'sev3';

export interface User {
  email: string;
  name: string;
}

export interface MeResponse extends User {
  is_admin: boolean;
}

export interface RCAHistoryEntry {
  id: number;
  actor_email: string;
  action: string;
  from_value: string | null;
  to_value: string | null;
  at: string;
}

export interface RCA {
  id: number;
  title: string;
  body: string;
  // Structured form payload mirroring `body`. Shape is owned by utils/rcaContent
  // (RCAContent); kept loose here to avoid an import cycle. Null for legacy RCAs
  // created before structured editing — those hydrate from `body` instead.
  content: Record<string, unknown> | null;
  status: RCAStatus;
  creator_email: string;
  creator_name: string;
  assignees: User[];
  created_at: string;
  updated_at: string;
  closed_at: string | null;
  ai_summary: string | null;
  ai_summary_at: string | null;
  ai_summary_model: string | null;
  can_edit: boolean;
  can_delete: boolean;
  severity: RCASeverity | null;
  environment: string | null;
  services_affected: string[];
  incident_started_at: string | null;
  incident_detected_at: string | null;
  incident_mitigated_at: string | null;
  incident_resolved_at: string | null;
}

export interface RCAListResponse {
  items: RCA[];
  total: number;
}

export interface AdminUser {
  email: string;
  name: string;
  is_admin: boolean;
  is_seed_admin: boolean;
  created_at: string;
  last_seen_at: string;
  rca_count: number;
}

export interface AdminUserListResponse {
  items: AdminUser[];
  total: number;
  page: number;
  page_size: number;
}

export interface AdminUserCreateInput {
  email: string;
  name?: string;
  is_admin?: boolean;
}
