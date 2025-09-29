// -------- TradingView --------
function initTradingView() {
  if (!window.TradingView) {
    console.error("TradingView script no cargó todavía.");
    return;
  }
  /* Crea el widget dentro de #tradingview_chart */
  // Docs: https://www.tradingview.com/widget/advanced-chart/
  window.tvWidget = new TradingView.widget({
    container_id: "tradingview_chart",
    autosize: true,
    symbol: "BINANCE:BTCUSDT",
    interval: "30",
    timezone: "Etc/UTC",
    theme: "dark",
    style: "1",
    locale: "es",
    toolbar_bg: "#0b1220",
    enable_publishing: false,
    hide_legend: false,
    allow_symbol_change: true,
    withdateranges: true,
    studies: [],
    details: false,
    hotlist: false,
    calendar: false,
  });
}
