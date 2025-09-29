"use client";
import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer } from "recharts";

const roiSeries = [
  { t: "01.24", roi: 10 },
  { t: "02.24", roi: 20 },
  { t: "03.24", roi: 15 },
  { t: "04.24", roi: 30 },
];

export default function Home() {
  return (
    <main className="min-h-screen p-6">
      <h1 className="text-2xl font-bold mb-4">Nevola Trading (Demo)</h1>

      <div className="bg-[#0f1624] p-4 rounded-2xl border border-slate-800">
        <h2 className="font-semibold mb-2">ROI Demo</h2>
        <div className="h-64">
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={roiSeries}>
              <XAxis dataKey="t" stroke="#94a3b8" />
              <YAxis stroke="#94a3b8" />
              <Tooltip
                contentStyle={{
                  background: "#0b1320",
                  border: "1px solid #1f2937",
                  color: "#e2e8f0",
                }}
              />
              <Line
                type="monotone"
                dataKey="roi"
                stroke="#22d3ee"
                strokeWidth={2}
                dot={false}
              />
            </LineChart>
          </ResponsiveContainer>
        </div>
      </div>
    </main>
  );
}
