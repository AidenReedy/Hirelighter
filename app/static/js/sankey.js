// Sankey of the job search, drawn with d3-sankey. Every node is direct-labeled with its count.
import { el } from "./util.js";

// Same highlighter colors as the status dropdowns; every node is also labeled, so color never stands alone.
const NODE_COLOR = {
  "Applied": "var(--cyan)",
  "Interview": "var(--purple)",
  "Offer": "var(--orange)",
  "Accepted": "var(--green)",
  "Declined": "var(--yellow)",
  "Rejected": "var(--pink)",
  "Rejected after interview": "var(--hot-pink)",
  "No response yet": "var(--card-2)",
  "In progress": "var(--purple)",
  "Deciding": "var(--orange)",
};

let tip;
function tooltip(evt, text) {
  if (!tip) { tip = el("div.tooltip"); document.body.append(tip); }
  if (!text) { tip.hidden = true; return; }
  tip.hidden = false;
  tip.textContent = text;
  const pad = 12;
  const x = Math.min(evt.clientX + pad, window.innerWidth - tip.offsetWidth - 8);
  tip.style.left = x + "px";
  tip.style.top = evt.clientY + pad + "px";
}

export function drawSankey(container, data) {
  container.replaceChildren();
  if (!data.links.length) {
    container.append(el("div.empty", "Log an application to see your search here."));
    return;
  }
  const width = Math.max(container.clientWidth || 800, 320);
  const narrow = width < 600;
  const height = narrow ? 300 : 340;
  const longest = Math.max(...data.nodes.map((n) => `${n.name} ${n.count}`.length));
  const labelRoom = Math.min(width * 0.45, longest * 6.8 + 16); // ~6.8px per char at 12px

  const graph = d3.sankey()
    .nodeWidth(14)
    .nodePadding(narrow ? 14 : 20)
    .nodeAlign(d3.sankeyJustify) // outcomes line up in the last column
    .nodeSort(null)
    .extent([[1, 8], [width - labelRoom, height - 8]])({
      nodes: data.nodes.map((n) => ({ ...n })),
      links: data.links.map((l) => ({ ...l })),
    });

  const svg = d3.create("svg").attr("viewBox", [0, 0, width, height]).attr("role", "img")
    .attr("aria-label", "Job search flow: " + data.nodes.map((n) => `${n.name} ${n.count}`).join(", "));

  svg.append("g").selectAll("path").data(graph.links).join("path")
    .attr("class", "link")
    .attr("d", d3.sankeyLinkHorizontal())
    .attr("stroke", (d) => NODE_COLOR[d.target.name] || "var(--muted)")
    .attr("stroke-width", (d) => Math.max(2, d.width))
    .on("mousemove", (e, d) => tooltip(e, `${d.source.name} → ${d.target.name}: ${d.value} job${d.value === 1 ? "" : "s"}`))
    .on("mouseleave", (e) => tooltip(e, null));

  const total = graph.nodes.find((n) => n.name === "Applied")?.value || 1;
  svg.append("g").selectAll("rect").data(graph.nodes).join("rect")
    .attr("x", (d) => d.x0).attr("y", (d) => d.y0)
    .attr("width", (d) => d.x1 - d.x0).attr("height", (d) => Math.max(2, d.y1 - d.y0))
    .attr("rx", 3)
    .attr("fill", (d) => NODE_COLOR[d.name] || "var(--muted)")
    .attr("stroke", "var(--ink)").attr("stroke-width", 2)
    .on("mousemove", (e, d) => tooltip(e, `${d.name}: ${d.value} (${Math.round((d.value / total) * 100)}% of applications)`))
    .on("mouseleave", (e) => tooltip(e, null));

  const label = svg.append("g").selectAll("text").data(graph.nodes).join("text")
    .attr("class", "node-label")
    .attr("paint-order", "stroke").attr("stroke", "var(--card)").attr("stroke-width", 4).attr("stroke-linejoin", "round")
    .attr("x", (d) => d.x1 + 8)
    .attr("y", (d) => (d.y0 + d.y1) / 2)
    .attr("dy", "0.35em");
  label.append("tspan").text((d) => d.name + " ");
  label.append("tspan").attr("class", "n").attr("font-weight", 600).text((d) => d.value);

  container.append(svg.node());
}
