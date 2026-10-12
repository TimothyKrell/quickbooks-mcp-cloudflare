import { Option, Schema } from "effect";

// QuickBooks report JSON nests sections several levels deep and spends most of
// its bytes on metadata. This renders it as indented, pipe-separated rows,
// which is far cheaper for a model to read.

const Cells = Schema.Array(Schema.Struct({ value: Schema.optional(Schema.String) }));

interface Row {
  readonly ColData?: typeof Cells.Type | undefined;
  readonly Header?: { readonly ColData?: typeof Cells.Type | undefined } | undefined;
  readonly Rows?: { readonly Row?: ReadonlyArray<Row> | undefined } | undefined;
  readonly Summary?: { readonly ColData?: typeof Cells.Type | undefined } | undefined;
}

const Row: Schema.Codec<Row> = Schema.Struct({
  ColData: Schema.optional(Cells),
  Header: Schema.optional(Schema.Struct({ ColData: Schema.optional(Cells) })),
  Rows: Schema.optional(Schema.Struct({ Row: Schema.optional(Schema.Array(Schema.suspend(() => Row))) })),
  Summary: Schema.optional(Schema.Struct({ ColData: Schema.optional(Cells) })),
});

const Report = Schema.Struct({
  Header: Schema.optional(
    Schema.Struct({
      ReportName: Schema.optional(Schema.String),
      StartPeriod: Schema.optional(Schema.String),
      EndPeriod: Schema.optional(Schema.String),
      Currency: Schema.optional(Schema.String),
      ReportBasis: Schema.optional(Schema.String),
      Option: Schema.optional(
        Schema.Array(Schema.Struct({ Name: Schema.optional(Schema.String), Value: Schema.optional(Schema.String) })),
      ),
    }),
  ),
  Columns: Schema.optional(
    Schema.Struct({
      Column: Schema.optional(Schema.Array(Schema.Struct({ ColTitle: Schema.optional(Schema.String) }))),
    }),
  ),
  Rows: Schema.optional(Schema.Struct({ Row: Schema.optional(Schema.Array(Row)) })),
});

const decodeReport = Schema.decodeUnknownOption(Report);

/** The report as text, or None if it isn't shaped like a QuickBooks report. */
export function formatReport(json: unknown): Option.Option<string> {
  return Option.map(decodeReport(json), (report) => {
    const header = report.Header ?? {};
    const period =
      header.StartPeriod || header.EndPeriod ? ` ${header.StartPeriod ?? "?"} to ${header.EndPeriod ?? "?"}` : "";
    const extras = [header.Currency, header.ReportBasis && `${header.ReportBasis} basis`].filter(Boolean).join(", ");
    const title = `${header.ReportName ?? "Report"}${period}${extras ? ` (${extras})` : ""}`;

    const noData = header.Option?.find((option) => option.Name === "NoReportData")?.Value === "true";
    if (noData) return `${title}\nNo data for this period.`;

    const lines = [title];
    const columns = report.Columns?.Column?.map((column) => column.ColTitle ?? "") ?? [];
    if (columns.some(Boolean)) lines.push(columns.join(" | "));

    const walk = (rows: ReadonlyArray<Row> | undefined, depth: number) => {
      for (const row of rows ?? []) {
        const indent = "  ".repeat(depth);
        if (row.ColData) lines.push(indent + cells(row.ColData));
        if (row.Header?.ColData) lines.push(indent + cells(row.Header.ColData));
        walk(row.Rows?.Row, depth + 1);
        if (row.Summary?.ColData) lines.push(indent + cells(row.Summary.ColData));
      }
    };
    walk(report.Rows?.Row, 0);
    return lines.join("\n");
  });
}

function cells(data: typeof Cells.Type): string {
  return data
    .map((cell) => cell.value ?? "")
    .join(" | ")
    .replace(/(\s\|\s)+$/, "");
}
