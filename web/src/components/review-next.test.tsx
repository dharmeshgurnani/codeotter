import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { JsonReport, type ReportSection } from "./json-report";
import { ReportSkeleton } from "./skeletons";

// Home's Review next section: server JSON through the generic report renderer, and the skeleton that mirrors it.
const next: ReportSection = {
  id: "next", kind: "table", title: "Review next",
  columns: ["#", "Pull request", "Repository", "Priority", "Risk", "Blast radius", "Gates", "Waiting", "Size", "Group"],
  rows: [
    [1, { text: "#12 auth", path: "/review?pr=12" }, "acme/api", { text: "64", mono: true, info: "risk 90 × 0.4: +36" }, { text: "90", tone: "bad" }, { text: "60", tone: "warn" }, { text: "1/3 failed", tone: "warn" }, { text: "overdue · 3d", tone: "bad" }, "+120 −4 · 3 files", { text: "#40", tone: "info" }],
    [2, { text: "#13 deps", path: "/review?pr=13" }, "acme/api", { text: "12", mono: true }, { text: "unscored", tone: "muted" }, "", "", "5h", "+3 −1 · 1 file", ""],
  ],
};

describe("Review next", () => {
  it("draws ranked rows with badges for risk, overdue and unscored", () => {
    render(<JsonReport sections={[next]} go={() => {}} />);
    expect(screen.getByText("Review next")).toBeTruthy();
    expect(screen.getByText("overdue · 3d").className).toContain("bg-red-50");
    expect(screen.getByText("unscored").className).toContain("bg-neutral-50");
    expect(screen.getByText("#12 auth")).toBeTruthy();
  });
  it("has a skeleton with the Review next table first", () => {
    const { container } = render(<ReportSkeleton />);
    const tables = container.querySelectorAll("table");
    expect(tables.length).toBe(3);
    expect(tables[0].querySelectorAll("thead th").length).toBe(10);
  });
});
