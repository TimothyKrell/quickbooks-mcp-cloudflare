import { Effect, Option, Schema } from "effect";
import { Tool, Toolkit } from "effect/ai";
import type { AppConfig } from "./config.ts";
import { EntitySchema, QboError, QboRecord, QuickBooks, VoidableEntitySchema, WritableEntitySchema } from "./qbo.ts";
import { formatReport } from "./report.ts";

const entity = EntitySchema.annotate({ description: "QuickBooks entity type, e.g. Invoice or Customer" });
const writableEntity = WritableEntitySchema.annotate({
  description: "QuickBooks entity type, e.g. Invoice or Customer",
});
const id = Schema.String.annotate({ description: "The record's Id" });

// Read-only tools are annotated as safe; write tools default to destructive.
// Every tool returns QuickBooks errors to the model as a tool error rather
// than failing the MCP request.
const common = { failure: QboError, failureMode: "return" as const, dependencies: [QuickBooks] };

const GetCompanyInfo = Tool.make("get_company_info", {
  ...common,
  description: "Get the connected QuickBooks company's name, address, fiscal year start and other details.",
  success: QboRecord,
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);

const GetPreferences = Tool.make("get_preferences", {
  ...common,
  description:
    "Get the company's accounting preferences: enabled features (classes, departments, multicurrency, sales tax), accounting method, default terms and similar settings.",
  success: QboRecord,
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);

const Query = Tool.make("query", {
  ...common,
  description: [
    "Search QuickBooks with its SQL-like query language. Works for every entity type, including ones get_entity doesn't list (Budget, CompanyCurrency, ...).",
    "Syntax: SELECT * | COUNT(*) | <fields> FROM <Entity> [WHERE <field> <op> <value> [AND ...]] [ORDERBY <field> [ASC|DESC]] [STARTPOSITION n] [MAXRESULTS n].",
    "Operators: =, <, >, <=, >=, IN, LIKE (with % wildcards). No OR, JOIN or GROUP BY. Quote strings with single quotes; dates are 'YYYY-MM-DD'.",
    "MAXRESULTS defaults to 100 and is at most 1000; page with STARTPOSITION (1-based).",
    "Examples: SELECT * FROM Invoice WHERE Balance > '0' ORDERBY DueDate; SELECT * FROM Customer WHERE DisplayName LIKE '%Smith%'; SELECT COUNT(*) FROM Bill WHERE TxnDate >= '2026-01-01'.",
    "Reference fields filter by Id: SELECT * FROM Invoice WHERE CustomerRef = '58'.",
  ].join("\n"),
  parameters: Schema.Struct({ query: Schema.String.annotate({ description: "A SELECT statement" }) }),
  success: QboRecord,
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);

const GetEntity = Tool.make("get_entity", {
  ...common,
  description: "Get one QuickBooks record by its Id, with every field including SyncToken.",
  parameters: Schema.Struct({ entity, id }),
  success: QboRecord,
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);

const GetReport = Tool.make("get_report", {
  ...common,
  description: [
    "Run a QuickBooks report. Common names: ProfitAndLoss, ProfitAndLossDetail, BalanceSheet, CashFlow, TrialBalance, GeneralLedger, TransactionList, AgedReceivables, AgedReceivableDetail, AgedPayables, AgedPayableDetail, CustomerBalance, CustomerBalanceDetail, CustomerIncome, CustomerSales, VendorBalance, VendorBalanceDetail, VendorExpenses, ItemSales, ClassSales, DepartmentSales, InventoryValuationSummary, AccountList.",
    "Common params: start_date and end_date (YYYY-MM-DD), date_macro (e.g. 'This Fiscal Year', 'Last Month', 'Year to Date'), accounting_method (Cash or Accrual), summarize_column_by (Total, Month, Quarter, Year, Customers, Vendors, Classes, Departments), customer, vendor, item, class, department (Ids, comma-separated).",
  ].join("\n"),
  parameters: Schema.Struct({
    report: Schema.String.annotate({ description: "Report name, e.g. ProfitAndLoss" }),
    params: Schema.optionalKey(
      Schema.Record(Schema.String, Schema.String).annotate({ description: "Report query parameters" }),
    ),
    format: Schema.optionalKey(Schema.Literals(["table", "json"])).annotate({
      description: "table: compact indented rows (default). json: the raw QuickBooks response.",
    }),
  }),
  success: Schema.Union([Schema.String, QboRecord]),
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);

const CreateEntity = Tool.make("create_entity", {
  ...common,
  description: [
    "Create a QuickBooks record. `data` is the entity's JSON body as documented in the QuickBooks Online Accounting API, using its field names (CustomerRef, Line, TxnDate, ...).",
    'Reference other records by Id, e.g. { "CustomerRef": { "value": "58" } }. Look up Ids with query first.',
    'Invoice example: { "CustomerRef": { "value": "58" }, "Line": [{ "Amount": 150, "DetailType": "SalesItemLineDetail", "SalesItemLineDetail": { "ItemRef": { "value": "1" }, "Qty": 1, "UnitPrice": 150 } }] }.',
  ].join("\n"),
  parameters: Schema.Struct({
    entity: writableEntity,
    data: QboRecord.annotate({ description: "The entity's JSON body" }),
  }),
  success: QboRecord,
}).annotate(Tool.Destructive, false);

const UpdateEntity = Tool.make("update_entity", {
  ...common,
  description:
    "Update a QuickBooks record. `data` must include Id; SyncToken is looked up if omitted. By default this is a sparse update: only the fields in `data` change. Set sparse to false to replace the whole record, which clears any writable field you leave out.",
  parameters: Schema.Struct({
    entity: writableEntity,
    data: QboRecord.annotate({ description: "Fields to change, including Id" }),
    sparse: Schema.optionalKey(Schema.Boolean.annotate({ description: "Default true" })),
  }),
  success: QboRecord,
}).annotate(Tool.Idempotent, true);

const DeleteEntity = Tool.make("delete_entity", {
  ...common,
  description:
    "Delete a QuickBooks transaction, or make a list record inactive (Account, Class, Customer, Department, Employee, Item, PaymentMethod, Term and Vendor can't be deleted, only deactivated). Deleting a transaction can't be undone.",
  parameters: Schema.Struct({ entity: writableEntity, id }),
  success: QboRecord,
});

const VoidTransaction = Tool.make("void_transaction", {
  ...common,
  description:
    "Void an Invoice, SalesReceipt, Payment or BillPayment. The record stays in QuickBooks with its amounts set to zero. This can't be undone.",
  parameters: Schema.Struct({ entity: VoidableEntitySchema, id }),
  success: QboRecord,
});

export const QboToolkit = Toolkit.make(
  GetCompanyInfo,
  GetPreferences,
  Query,
  GetEntity,
  GetReport,
  CreateEntity,
  UpdateEntity,
  DeleteEntity,
  VoidTransaction,
);

export type ToolName = keyof typeof QboToolkit.tools;

/** Whether the Worker's ALLOW_* settings expose a tool. */
export function isEnabled(config: AppConfig["Service"], name: ToolName): boolean {
  switch (name) {
    case "create_entity":
      return config.allowCreate;
    case "update_entity":
      return config.allowUpdate;
    case "delete_entity":
    case "void_transaction":
      return config.allowDelete;
    default:
      return true;
  }
}

export const QboToolkitHandlers = QboToolkit.toLayer({
  get_company_info: () => QuickBooks.use((qbo) => qbo.companyInfo),
  get_preferences: () => QuickBooks.use((qbo) => qbo.preferences),
  query: ({ query }) =>
    /^\s*select\s/i.test(query)
      ? QuickBooks.use((qbo) => qbo.query(query))
      : Effect.fail(new QboError({ message: "Only SELECT statements are supported.", status: 400 })),
  get_entity: ({ entity, id }) => QuickBooks.use((qbo) => qbo.get(entity, id)),
  get_report: ({ report, params, format }) =>
    QuickBooks.use((qbo) => qbo.report(report, params ?? {})).pipe(
      Effect.map((json) =>
        format === "json" ? json : Option.getOrElse(formatReport(json), (): string | QboRecord => json),
      ),
    ),
  create_entity: ({ entity, data }) => QuickBooks.use((qbo) => qbo.create(entity, data)),
  update_entity: ({ entity, data, sparse }) => QuickBooks.use((qbo) => qbo.update(entity, data, sparse ?? true)),
  delete_entity: ({ entity, id }) => QuickBooks.use((qbo) => qbo.delete(entity, id)),
  void_transaction: ({ entity, id }) => QuickBooks.use((qbo) => qbo.void(entity, id)),
});
