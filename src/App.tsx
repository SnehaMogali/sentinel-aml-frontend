import { useEffect, useState, type ChangeEvent, type DragEvent, type FormEvent } from "react";
import "./App.css";
import type {
  AlertResponse,
  CaseDispositionStatus,
  TransactionIngestRequest,
} from "./sentinelApiTypes";

const SENTINEL_API_BASE_URL = "http://localhost:8080/api/v1";

const DISPOSITION_STATUS_OPTIONS: CaseDispositionStatus[] = [
  "CLEARED_FALSE_POSITIVE",
  "ESCALATED_TO_FIU",
  "CONFIRMED_SUSPICIOUS",
];

const REQUIRED_CSV_COLUMNS = [
  "accountId",
  "amount",
  "currencyCode",
  "counterpartyCountryCode",
  "channel",
] as const;

// Keyed config so additional CSV data types (e.g. customers, accounts) can be
// added later by extending this map and its matching parser/endpoint.
const CSV_DATA_TYPES = {
  transactions: {
    label: "Transactions",
    ingestEndpointPath: "/ingest/transactions",
    requiredColumns: REQUIRED_CSV_COLUMNS,
  },
} as const;

type CsvDataType = keyof typeof CSV_DATA_TYPES;

type StatusTone = "info" | "success" | "error";
interface StatusMessage {
  text: string;
  tone: StatusTone;
}

const emptyIngestForm: TransactionIngestRequest = {
  accountId: "",
  amount: 0,
  currencyCode: "USD",
  counterpartyCountryCode: "US",
  channel: "WIRE",
  transactionTimestamp: new Date().toISOString(),
};

function formatEnumLabel(value: string): string {
  return value.replace(/_/g, " ");
}

function riskTone(score: number): "high" | "medium" | "low" {
  if (score >= 80) return "high";
  if (score >= 50) return "medium";
  return "low";
}

// Handles quoted fields (including embedded commas and escaped "" quotes).
function parseCsvLine(line: string): string[] {
  const fields: string[] = [];
  let field = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (inQuotes) {
      if (char === '"') {
        if (line[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += char;
      }
    } else if (char === '"') {
      inQuotes = true;
    } else if (char === ",") {
      fields.push(field);
      field = "";
    } else {
      field += char;
    }
  }
  fields.push(field);
  return fields;
}

interface CsvParseResult {
  transactions: TransactionIngestRequest[];
  errors: string[];
}

function parseTransactionsCsv(csvText: string): CsvParseResult {
  const lines = csvText.split(/\r\n|\n|\r/).filter((line) => line.trim().length > 0);
  if (lines.length === 0) {
    return { transactions: [], errors: ["CSV file is empty."] };
  }

  const headerCells = parseCsvLine(lines[0]).map((cell) => cell.trim());
  const columnIndexByName = new Map<string, number>();
  headerCells.forEach((name, index) => columnIndexByName.set(name.toLowerCase(), index));

  const missingColumns = REQUIRED_CSV_COLUMNS.filter(
    (column) => !columnIndexByName.has(column.toLowerCase())
  );
  if (missingColumns.length > 0) {
    return {
      transactions: [],
      errors: [`CSV is missing required column(s): ${missingColumns.join(", ")}`],
    };
  }

  const timestampIndex = columnIndexByName.get("transactiontimestamp");
  const transactions: TransactionIngestRequest[] = [];
  const errors: string[] = [];

  for (let rowIndex = 1; rowIndex < lines.length; rowIndex++) {
    const cells = parseCsvLine(lines[rowIndex]);
    const getCell = (column: string) => {
      const index = columnIndexByName.get(column.toLowerCase());
      return index === undefined ? "" : (cells[index]?.trim() ?? "");
    };

    const accountId = getCell("accountId");
    const amount = Number(getCell("amount"));
    const currencyCode = getCell("currencyCode");
    const counterpartyCountryCode = getCell("counterpartyCountryCode");
    const channel = getCell("channel");
    const transactionTimestamp =
      timestampIndex !== undefined ? (cells[timestampIndex]?.trim() ?? "") : "";

    if (!accountId || !currencyCode || !counterpartyCountryCode || !channel || Number.isNaN(amount)) {
      errors.push(`Row ${rowIndex + 1}: invalid or missing required field(s).`);
      continue;
    }

    transactions.push({
      accountId,
      amount,
      currencyCode,
      counterpartyCountryCode,
      channel,
      transactionTimestamp: transactionTimestamp || new Date().toISOString(),
    });
  }

  return { transactions, errors };
}

function App() {
  const [alerts, setAlerts] = useState<AlertResponse[]>([]);
  const [isLoadingAlerts, setIsLoadingAlerts] = useState(false);
  const [alertsLoadError, setAlertsLoadError] = useState("");

  const [ingestForm, setIngestForm] = useState<TransactionIngestRequest>(emptyIngestForm);
  const [ingestStatus, setIngestStatus] = useState<StatusMessage | null>(null);
  const [isSubmittingIngest, setIsSubmittingIngest] = useState(false);

  const [expandedDispositionAlertId, setExpandedDispositionAlertId] = useState<number | null>(null);
  const [dispositionReasonByAlertId, setDispositionReasonByAlertId] = useState<Record<number, string>>({});
  const [analystIdByAlertId, setAnalystIdByAlertId] = useState<Record<number, string>>({});
  const [dispositionErrorByAlertId, setDispositionErrorByAlertId] = useState<Record<number, string>>({});

  const [csvDataType, setCsvDataType] = useState<CsvDataType>("transactions");
  const [csvFileName, setCsvFileName] = useState("");
  const [csvTransactions, setCsvTransactions] = useState<TransactionIngestRequest[]>([]);
  const [csvParseErrors, setCsvParseErrors] = useState<string[]>([]);
  const [isUploadingCsv, setIsUploadingCsv] = useState(false);
  const [csvStatus, setCsvStatus] = useState<StatusMessage | null>(null);
  const [isDraggingCsv, setIsDraggingCsv] = useState(false);

  async function refreshAlertQueue() {
    setIsLoadingAlerts(true);
    setAlertsLoadError("");
    try {
      const response = await fetch(`${SENTINEL_API_BASE_URL}/alerts`);
      if (!response.ok) {
        setAlertsLoadError(`Could not load alerts (HTTP ${response.status}).`);
        return;
      }
      const alertsSortedByRisk: AlertResponse[] = await response.json();
      setAlerts(alertsSortedByRisk);
    } catch {
      setAlertsLoadError("Could not reach the Sentinel API. Is the backend running on localhost:8080?");
    } finally {
      setIsLoadingAlerts(false);
    }
  }

  useEffect(() => {
    refreshAlertQueue();
  }, []);

  async function handleIngestSubmit(event: FormEvent) {
    event.preventDefault();
    setIsSubmittingIngest(true);
    setIngestStatus({ text: "Ingesting...", tone: "info" });
    try {
      const response = await fetch(`${SENTINEL_API_BASE_URL}/ingest/transactions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify([{ ...ingestForm, amount: Number(ingestForm.amount) }]),
      });
      if (!response.ok) {
        setIngestStatus({ text: `Ingest failed: HTTP ${response.status}`, tone: "error" });
        return;
      }
      const result = await response.json();
      setIngestStatus({
        text: `Ingested ${result.transactionsIngested} transaction(s), ${result.alertsCreatedOrUpdated} alert(s) created/updated.`,
        tone: "success",
      });
      await refreshAlertQueue();
    } catch {
      setIngestStatus({ text: "Could not reach the Sentinel API.", tone: "error" });
    } finally {
      setIsSubmittingIngest(false);
    }
  }

  function processCsvFile(file: File) {
    setCsvFileName(file.name);
    setCsvStatus(null);
    setCsvTransactions([]);
    setCsvParseErrors([]);

    const reader = new FileReader();
    reader.onload = () => {
      const { transactions, errors } = parseTransactionsCsv(String(reader.result ?? ""));
      setCsvTransactions(transactions);
      setCsvParseErrors(errors);
    };
    reader.onerror = () => setCsvParseErrors(["Could not read the selected file."]);
    reader.readAsText(file);
  }

  function handleCsvDataTypeChange(event: ChangeEvent<HTMLSelectElement>) {
    setCsvDataType(event.target.value as CsvDataType);
    setCsvFileName("");
    setCsvTransactions([]);
    setCsvParseErrors([]);
    setCsvStatus(null);
  }

  function handleCsvFileInputChange(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (file) processCsvFile(file);
  }

  function handleCsvDrop(event: DragEvent<HTMLLabelElement>) {
    event.preventDefault();
    setIsDraggingCsv(false);
    const file = event.dataTransfer.files?.[0];
    if (file) processCsvFile(file);
  }

  async function handleCsvUpload() {
    if (csvTransactions.length === 0) return;
    setIsUploadingCsv(true);
    setCsvStatus({ text: "Uploading...", tone: "info" });
    try {
      const response = await fetch(`${SENTINEL_API_BASE_URL}${CSV_DATA_TYPES[csvDataType].ingestEndpointPath}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(csvTransactions),
      });
      if (!response.ok) {
        setCsvStatus({ text: `CSV ingest failed: HTTP ${response.status}`, tone: "error" });
        return;
      }
      const result = await response.json();
      setCsvStatus({
        text: `Ingested ${result.transactionsIngested} transaction(s) from CSV, ${result.alertsCreatedOrUpdated} alert(s) created/updated.`,
        tone: "success",
      });
      setCsvTransactions([]);
      setCsvParseErrors([]);
      setCsvFileName("");
      await refreshAlertQueue();
    } catch {
      setCsvStatus({ text: "Could not reach the Sentinel API.", tone: "error" });
    } finally {
      setIsUploadingCsv(false);
    }
  }

  function toggleDispositionForm(alertId: number) {
    setExpandedDispositionAlertId((current) => (current === alertId ? null : alertId));
    setDispositionErrorByAlertId((current) => ({ ...current, [alertId]: "" }));
  }

  async function handleDispositionSubmit(alertId: number, dispositionStatus: CaseDispositionStatus) {
    const dispositionReason = dispositionReasonByAlertId[alertId] ?? "";
    const analystId = analystIdByAlertId[alertId] ?? "";
    if (!dispositionReason || !analystId) {
      setDispositionErrorByAlertId((current) => ({
        ...current,
        [alertId]: "Enter a disposition reason and analyst ID first.",
      }));
      return;
    }
    const response = await fetch(`${SENTINEL_API_BASE_URL}/alerts/${alertId}/disposition`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ dispositionStatus, dispositionReason, analystId }),
    });
    if (!response.ok) {
      setDispositionErrorByAlertId((current) => ({
        ...current,
        [alertId]: `Disposition failed: HTTP ${response.status}`,
      }));
      return;
    }
    setExpandedDispositionAlertId(null);
    await refreshAlertQueue();
  }

  const openAlertCount = alerts.filter((alert) => alert.status === "OPEN").length;

  return (
    <div className="sentinel-app">
      <header className="app-header">
        <h1>Sentinel AML</h1>
        <p className="app-subtitle">Analyst console for transaction monitoring &amp; case review</p>
      </header>

      <section className="card">
        <h2>Ingest a Transaction</h2>
        <p className="card-hint">Submit a single transaction manually for real-time detection.</p>
        <form onSubmit={handleIngestSubmit} className="ingest-form">
          <label className="field">
            <span>Account ID</span>
            <input
              placeholder="e.g. ACC_000001"
              value={ingestForm.accountId}
              onChange={(e) => setIngestForm({ ...ingestForm, accountId: e.target.value })}
              required
            />
          </label>
          <label className="field">
            <span>Amount</span>
            <input
              type="number"
              placeholder="0.00"
              value={ingestForm.amount}
              onChange={(e) => setIngestForm({ ...ingestForm, amount: Number(e.target.value) })}
              required
            />
          </label>
          <label className="field">
            <span>Currency</span>
            <input
              placeholder="e.g. USD"
              value={ingestForm.currencyCode}
              onChange={(e) => setIngestForm({ ...ingestForm, currencyCode: e.target.value })}
              required
            />
          </label>
          <label className="field">
            <span>Counterparty Country</span>
            <input
              placeholder="e.g. IR"
              value={ingestForm.counterpartyCountryCode}
              onChange={(e) => setIngestForm({ ...ingestForm, counterpartyCountryCode: e.target.value })}
              required
            />
          </label>
          <label className="field">
            <span>Channel</span>
            <input
              placeholder="e.g. WIRE"
              value={ingestForm.channel}
              onChange={(e) => setIngestForm({ ...ingestForm, channel: e.target.value })}
              required
            />
          </label>
          <button type="submit" className="btn btn-primary" disabled={isSubmittingIngest}>
            {isSubmittingIngest ? "Submitting..." : "Submit Transaction"}
          </button>
        </form>
        {ingestStatus && <p className={`status-message status-${ingestStatus.tone}`}>{ingestStatus.text}</p>}
      </section>

      <section className="card">
        <h2>Bulk Ingest from CSV</h2>
        <div className="field field-inline">
          <span>Data type</span>
          <select value={csvDataType} onChange={handleCsvDataTypeChange}>
            {Object.entries(CSV_DATA_TYPES).map(([key, config]) => (
              <option key={key} value={key}>
                {config.label}
              </option>
            ))}
          </select>
        </div>
        <p className="card-hint">
          Required columns: <code>{CSV_DATA_TYPES[csvDataType].requiredColumns.join(", ")}</code>. Optional:{" "}
          <code>transactionTimestamp</code> (ISO 8601, defaults to now).
        </p>

        <label
          className={`csv-dropzone ${isDraggingCsv ? "csv-dropzone-active" : ""}`}
          onDragOver={(e) => {
            e.preventDefault();
            setIsDraggingCsv(true);
          }}
          onDragLeave={() => setIsDraggingCsv(false)}
          onDrop={handleCsvDrop}
        >
          <input type="file" accept=".csv,text/csv" onChange={handleCsvFileInputChange} hidden />
          <span className="csv-dropzone-icon" aria-hidden="true">
            ⭱
          </span>
          <span>
            {csvFileName ? (
              <>
                Selected: <strong>{csvFileName}</strong>
              </>
            ) : (
              <>
                <strong>Click to browse</strong> or drag a CSV file here
              </>
            )}
          </span>
        </label>

        {csvParseErrors.length > 0 && (
          <ul className="csv-errors">
            {csvParseErrors.map((error, index) => (
              <li key={index}>{error}</li>
            ))}
          </ul>
        )}

        {csvTransactions.length > 0 && (
          <>
            <table className="csv-preview">
              <thead>
                <tr>
                  <th>Account ID</th>
                  <th>Amount</th>
                  <th>Currency</th>
                  <th>Counterparty Country</th>
                  <th>Channel</th>
                  <th>Timestamp</th>
                </tr>
              </thead>
              <tbody>
                {csvTransactions.slice(0, 5).map((transaction, index) => (
                  <tr key={index}>
                    <td>{transaction.accountId}</td>
                    <td>{transaction.amount}</td>
                    <td>{transaction.currencyCode}</td>
                    <td>{transaction.counterpartyCountryCode}</td>
                    <td>{transaction.channel}</td>
                    <td>{transaction.transactionTimestamp}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {csvTransactions.length > 5 && (
              <p className="card-hint">...and {csvTransactions.length - 5} more row(s).</p>
            )}
          </>
        )}

        <div className="csv-upload-actions">
          <button
            type="button"
            className="btn btn-primary"
            onClick={handleCsvUpload}
            disabled={csvTransactions.length === 0 || isUploadingCsv}
          >
            {isUploadingCsv
              ? "Uploading..."
              : `Upload ${csvTransactions.length > 0 ? csvTransactions.length : ""} Record(s)`.trim()}
          </button>
        </div>
        {csvStatus && <p className={`status-message status-${csvStatus.tone}`}>{csvStatus.text}</p>}
      </section>

      <section className="card">
        <div className="alert-queue-header">
          <div>
            <h2>Alert Queue</h2>
            <p className="card-hint">
              {isLoadingAlerts ? "Loading..." : `${openAlertCount} open of ${alerts.length} total`}
            </p>
          </div>
          <button type="button" className="btn btn-secondary" onClick={refreshAlertQueue} disabled={isLoadingAlerts}>
            {isLoadingAlerts ? "Refreshing..." : "Refresh"}
          </button>
        </div>

        {alertsLoadError && <p className="status-message status-error">{alertsLoadError}</p>}

        {!alertsLoadError && alerts.length === 0 && !isLoadingAlerts && (
          <p className="empty-state">No alerts yet. Ingest a transaction to trigger detection.</p>
        )}

        {alerts.length > 0 && (
          <table className="alert-table">
            <thead>
              <tr>
                <th>ID</th>
                <th>Customer</th>
                <th>Rule</th>
                <th>Risk</th>
                <th>Status</th>
                <th>Explanation</th>
                <th>Disposition</th>
              </tr>
            </thead>
            <tbody>
              {alerts.map((alert) => (
                <tr key={alert.alertId}>
                  <td>{alert.alertId}</td>
                  <td>{alert.customerId}</td>
                  <td>
                    <span className="tag">{formatEnumLabel(alert.triggeredRuleType)}</span>
                  </td>
                  <td>
                    <span className={`badge badge-${riskTone(alert.riskScore)}`}>{alert.riskScore}</span>
                  </td>
                  <td>
                    <span className={`pill pill-${alert.status === "OPEN" ? "open" : "closed"}`}>
                      {formatEnumLabel(alert.status)}
                    </span>
                  </td>
                  <td className="explanation-cell">{alert.explanation}</td>
                  <td>
                    {alert.status === "OPEN" ? (
                      expandedDispositionAlertId === alert.alertId ? (
                        <div className="disposition-controls">
                          <input
                            placeholder="Reason"
                            value={dispositionReasonByAlertId[alert.alertId] ?? ""}
                            onChange={(e) =>
                              setDispositionReasonByAlertId({
                                ...dispositionReasonByAlertId,
                                [alert.alertId]: e.target.value,
                              })
                            }
                          />
                          <input
                            placeholder="Analyst ID"
                            value={analystIdByAlertId[alert.alertId] ?? ""}
                            onChange={(e) =>
                              setAnalystIdByAlertId({
                                ...analystIdByAlertId,
                                [alert.alertId]: e.target.value,
                              })
                            }
                          />
                          <div className="disposition-buttons">
                            {DISPOSITION_STATUS_OPTIONS.map((status) => (
                              <button
                                key={status}
                                type="button"
                                className="btn btn-small"
                                onClick={() => handleDispositionSubmit(alert.alertId, status)}
                              >
                                {formatEnumLabel(status)}
                              </button>
                            ))}
                          </div>
                          <button
                            type="button"
                            className="btn btn-small btn-ghost"
                            onClick={() => toggleDispositionForm(alert.alertId)}
                          >
                            Cancel
                          </button>
                          {dispositionErrorByAlertId[alert.alertId] && (
                            <p className="status-message status-error status-message-small">
                              {dispositionErrorByAlertId[alert.alertId]}
                            </p>
                          )}
                        </div>
                      ) : (
                        <button
                          type="button"
                          className="btn btn-small btn-secondary"
                          onClick={() => toggleDispositionForm(alert.alertId)}
                        >
                          Add Disposition
                        </button>
                      )
                    ) : (
                      <span className="muted">—</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}

export default App;
