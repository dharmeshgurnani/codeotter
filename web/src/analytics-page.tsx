import { useEffect, useState } from "react";
import { JsonReport, type ReportSection } from "@/components/json-report";
import { AnalyticsSkeleton } from "@/components/skeletons";

type Period = { value: number; options: { value: number; label: string }[] };

// Thin shell like Home: the server computes the sections and the period choices; the generic renderer draws them.
export function AnalyticsPage({ go, version, org }: { go: (p: string) => void; version: number; org: string }) {
  const [days, setDays] = useState(30);
  const [data, setData] = useState<{ sections: ReportSection[]; period: Period } | null>(null);
  const [err, setErr] = useState("");
  useEffect(() => {
    let alive = true;
    setData(null);
    setErr("");
    fetch(`/api/analytics?org=${encodeURIComponent(org)}&days=${days}`)
      .then(async (r) => (r.ok ? r.json() : Promise.reject(new Error((await r.json().catch(() => ({}))).error || `${r.status}`))))
      .then((d) => alive && setData({ sections: Array.isArray(d?.sections) ? d.sections : [], period: d?.period ?? { value: days, options: [] } }))
      .catch((e) => alive && setErr(e.message));
    return () => { alive = false; };
  }, [version, org, days]);
  if (err) return <p className="text-sm text-red-700">{err}</p>;
  return (
    <div className="space-y-6">
      <select aria-label="Period" className="h-9 rounded-md border border-input bg-transparent px-3 text-sm" value={days} onChange={(e) => setDays(Number(e.target.value))}>
        {(data?.period.options.length ? data.period.options : [7, 30, 90].map((v) => ({ value: v, label: `Last ${v} days` }))).map((o) => (
          <option key={o.value} value={o.value}>{o.label}</option>
        ))}
      </select>
      {data ? <JsonReport sections={data.sections} go={go} /> : <AnalyticsSkeleton />}
    </div>
  );
}
