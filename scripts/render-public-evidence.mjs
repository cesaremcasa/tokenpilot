import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sources = [
  ["Codex", "docs/evidence/2026-10-06/openai-reductions.json"],
  ["Grok", "docs/evidence/2026-10-06/grok-reductions.json"]
];
const records = sources.flatMap(([provider, file]) => {
  const evidence = JSON.parse(fs.readFileSync(path.join(root, file), "utf8"));
  return evidence.models.map(({ model, reductionPercent }) => ({ provider, model, reductionPercent }));
});

const width = 1000;
const left = 250;
const chartWidth = 620;
const rowHeight = 36;
const top = 155;
const height = top + records.length * rowHeight + 95;
const x = (value) => left + chartWidth * value / 100;
const colors = { Codex: "#5b6ee1", Grok: "#139b83" };
const ticks = [0, 20, 40, 60, 80, 100];
const lines = records.map((record, index) => {
  const y = top + index * rowHeight;
  const value = record.reductionPercent;
  return `<text x="${left - 16}" y="${y + 5}" text-anchor="end" class="model">${record.model}</text><rect x="${left}" y="${y - 10}" width="${chartWidth}" height="18" rx="9" fill="#edf0f5"/><rect x="${left}" y="${y - 10}" width="${(chartWidth * value / 100).toFixed(2)}" height="18" rx="9" fill="${colors[record.provider]}"/><text x="${Math.min(x(value) + 10, 940)}" y="${y + 5}" class="value">${value.toFixed(2)}%</text>`;
}).join("\n");
const grid = ticks.map((tick) => `<line x1="${x(tick)}" y1="${top - 27}" x2="${x(tick)}" y2="${top + records.length * rowHeight - 12}" stroke="${tick === 42 ? "#d49528" : "#dce1e9"}" stroke-dasharray="${tick === 42 ? "5 5" : "2 5"}"/><text x="${x(tick)}" y="${top - 38}" text-anchor="middle" class="tick">${tick}%</text>`).join("\n");
const legend = Object.entries(colors).map(([name, color], index) => `<rect x="${left + index * 120}" y="${height - 48}" width="12" height="12" rx="3" fill="${color}"/><text x="${left + 18 + index * 120}" y="${height - 37}" class="legend">${name}</text>`).join("\n");

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
<style>text{font-family:Inter,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;fill:#202638}.title{font-size:29px;font-weight:700}.subtitle{font-size:14px;fill:#606a7b}.model{font-size:14px}.value{font-size:14px;font-weight:650}.tick{font-size:12px;fill:#606a7b}.legend{font-size:13px}.note{font-size:12px;fill:#606a7b}</style>
<rect width="100%" height="100%" fill="#fff"/><text x="48" y="55" class="title">Measured input + output reduction</text>
<text x="48" y="82" class="subtitle">13 models · controlled real A/B · one recorded pair per model and policy · 2026-10-06 evidence</text>
${grid}<line x1="${x(42)}" y1="${top - 27}" x2="${x(42)}" y2="${top + records.length * rowHeight - 12}" stroke="#d49528" stroke-width="2" stroke-dasharray="5 5"/>
<text x="${x(42) + 7}" y="${top - 18}" class="tick" fill="#91610d">42% reference</text>${lines}
${legend}<text x="48" y="${height - 18}" class="note">Cached input included. Task-specific paired measurements; no universal savings guarantee.</text>
</svg>`;
fs.mkdirSync(path.join(root, "docs/assets"), { recursive: true });
fs.writeFileSync(path.join(root, "docs/assets/measured-reductions.svg"), svg);
console.log(`Rendered ${records.length} evidence rows to docs/assets/measured-reductions.svg`);
