export type DetectionRuleType = "LARGE_TRANSACTION" | "STRUCTURING" | "HIGH_RISK_JURISDICTION";
export type AlertStatus = "OPEN" | "DISPOSITIONED";
export type CaseDispositionStatus = "CLEARED_FALSE_POSITIVE" | "ESCALATED_TO_FIU" | "CONFIRMED_SUSPICIOUS";

export interface AlertResponse {
  alertId: number;
  customerId: string;
  triggeredRuleType: DetectionRuleType;
  riskScore: number;
  explanation: string;
  evidenceTransactionIds: string[];
  status: AlertStatus;
  createdAt: string;
}

export interface CaseDispositionRequest {
  dispositionStatus: CaseDispositionStatus;
  dispositionReason: string;
  analystId: string;
}

export interface CaseResponse {
  caseId: number;
  alertId: number;
  dispositionStatus: CaseDispositionStatus;
  dispositionReason: string;
  analystId: string;
  dispositionedAt: string;
}

export interface TransactionIngestRequest {
  accountId: string;
  amount: number;
  currencyCode: string;
  counterpartyCountryCode: string;
  channel: string;
  transactionTimestamp: string;
}

export interface TransactionIngestResult {
  transactionsIngested: number;
  alertsCreatedOrUpdated: number;
}
