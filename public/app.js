// -------- Reset demo --------
async function resetDemo() {
  const res = await fetch("/api/reset", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ balance: 1000, price: 60000 }) // valores iniciales
  });
  const json = await res.json();
  if (json.ok) renderState(json.state);
}
