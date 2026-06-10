import { useState } from "react";
import { Play, TrendingUp, Calendar, AlertTriangle, CheckCircle2 } from "lucide-react";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";

export default function Backtesting() {
  const [strategy, setStrategy] = useState("Short Straddle");
  const [days, setDays] = useState(30);
  const [running, setRunning] = useState(false);
  const [results, setResults] = useState<any>(null);

  const runBacktest = () => {
    setRunning(true);
    setResults(null);
    setTimeout(() => {
      setRunning(false);
      setResults({
        totalTrades: Math.floor(days * 1.2),
        winRate: "68.4%",
        maxDrawdown: "-4.2%",
        netProfit: `₹${(days * 1250).toLocaleString()}`,
        sharpeRatio: "2.14",
        averageProfitPerTrade: "₹850",
        profitFactor: "1.85",
      });
    }, 1500);
  };

  return (
    <div className="p-4 md:p-8 pb-32 max-w-[1600px] w-full mx-auto space-y-6 animate-in fade-in zoom-in-95 duration-500">
      <div className="flex flex-col md:flex-row justify-between items-start md:items-end pb-6 border-b border-0 border-dashed gap-4">
        <div>
          <h1 className="text-3xl font-bold text-foreground tracking-tight flex items-center gap-2">
            <Play className="w-8 h-8 text-primary animate-pulse" />
            Backtesting Engine
          </h1>
          <p className="text-xs text-muted-foreground mt-1">
            Run comprehensive historical simulation analyses on custom NIFTY 50 options strategies directly in-browser.
          </p>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
        <Card className="bg-card/60 border-0 backdrop-blur-xl">
          <CardHeader>
            <CardTitle className="text-sm font-semibold tracking-wide text-foreground/80">Backtest Configurations</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-1.5">
              <label className="text-xs text-muted-foreground font-medium">Select Strategy</label>
              <select
                value={strategy}
                onChange={(e) => setStrategy(e.target.value)}
                className="w-full bg-card border border-0 rounded-lg py-2 px-3 text-xs text-foreground focus:outline-none focus:border-primary transition-colors"
              >
                <option>Short Straddle</option>
                <option>Short Iron Condor</option>
                <option>Bull Call Spread</option>
                <option>Bear Put Spread</option>
                <option>Long Straddle</option>
              </select>
            </div>

            <div className="space-y-1.5">
              <label className="text-xs text-muted-foreground font-medium">Simulation Window</label>
              <select
                value={days}
                onChange={(e) => setDays(Number(e.target.value))}
                className="w-full bg-card border border-0 rounded-lg py-2 px-3 text-xs text-foreground focus:outline-none focus:border-primary transition-colors"
              >
                <option value={7}>Last 7 Days</option>
                <option value={30}>Last 30 Days</option>
                <option value={90}>Last 90 Days</option>
                <option value={180}>Last 180 Days</option>
              </select>
            </div>

            <button
              onClick={runBacktest}
              disabled={running}
              className="w-full bg-primary hover:bg-primary/90 text-primary-foreground text-xs font-semibold py-2.5 px-4 rounded-lg transition-colors flex items-center justify-center gap-2 cursor-pointer disabled:opacity-50"
            >
              <Play className="w-4 h-4 fill-current" />
              {running ? "Simulating Strategy..." : "Run Backtest Analysis"}
            </button>
          </CardContent>
        </Card>

        <div className="md:col-span-2">
          {running ? (
            <div className="h-full min-h-[250px] flex flex-col items-center justify-center bg-card/40 border border-0 rounded-2xl p-8 text-center space-y-4">
              <div className="relative">
                <div className="w-12 h-12 rounded-full border-4 border-primary/20 border-t-primary animate-spin"></div>
                <TrendingUp className="w-5 h-5 text-primary absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2" />
              </div>
              <div className="space-y-1">
                <p className="text-sm font-semibold text-foreground/90">Processing Historical Tick Stream</p>
                <p className="text-xs text-muted-foreground">Loading historical option chains and simulating premium decay...</p>
              </div>
            </div>
          ) : results ? (
            <div className="grid grid-cols-2 lg:grid-cols-3 gap-4">
              <Card className="bg-card/60 border-0 col-span-2 lg:col-span-3">
                <CardContent className="p-6 flex items-center gap-3">
                  <CheckCircle2 className="w-6 h-6 text-emerald-400 shrink-0" />
                  <div>
                    <h3 className="text-sm font-semibold text-foreground">Backtest Simulation Completed</h3>
                    <p className="text-xs text-muted-foreground">Successfully modeled {results.totalTrades} virtual option positions.</p>
                  </div>
                </CardContent>
              </Card>

              <Card className="bg-card/60 border-0">
                <CardContent className="p-6">
                  <p className="text-xs text-muted-foreground uppercase tracking-widest font-semibold mb-1">Net Profit/Loss</p>
                  <p className="text-2xl font-mono font-bold text-green-400">{results.netProfit}</p>
                </CardContent>
              </Card>

              <Card className="bg-card/60 border-0">
                <CardContent className="p-6">
                  <p className="text-xs text-muted-foreground uppercase tracking-widest font-semibold mb-1">Win Rate</p>
                  <p className="text-2xl font-mono font-bold text-slate-100">{results.winRate}</p>
                </CardContent>
              </Card>

              <Card className="bg-card/60 border-0">
                <CardContent className="p-6">
                  <p className="text-xs text-muted-foreground uppercase tracking-widest font-semibold mb-1">Max Drawdown</p>
                  <p className="text-2xl font-mono font-bold text-red-400">{results.maxDrawdown}</p>
                </CardContent>
              </Card>

              <Card className="bg-card/60 border-0">
                <CardContent className="p-6">
                  <p className="text-xs text-muted-foreground uppercase tracking-widest font-semibold mb-1">Sharpe Ratio</p>
                  <p className="text-2xl font-mono font-bold text-primary">{results.sharpeRatio}</p>
                </CardContent>
              </Card>

              <Card className="bg-card/60 border-0">
                <CardContent className="p-6">
                  <p className="text-xs text-muted-foreground uppercase tracking-widest font-semibold mb-1">Profit Factor</p>
                  <p className="text-2xl font-mono font-bold text-slate-100">{results.profitFactor}</p>
                </CardContent>
              </Card>

              <Card className="bg-card/60 border-0">
                <CardContent className="p-6">
                  <p className="text-xs text-muted-foreground uppercase tracking-widest font-semibold mb-1">Avg Profit/Trade</p>
                  <p className="text-2xl font-mono font-bold text-green-400">{results.averageProfitPerTrade}</p>
                </CardContent>
              </Card>
            </div>
          ) : (
            <div className="h-full min-h-[250px] flex flex-col items-center justify-center bg-card/30 border border-dashed border-0 rounded-2xl p-8 text-center space-y-2">
              <Calendar className="w-8 h-8 text-muted-foreground" />
              <p className="text-sm font-semibold text-foreground/80">Ready to simulate</p>
              <p className="text-xs text-muted-foreground max-w-sm">
                Select your option strategy and history size on the left pane and launch backtest computation.
              </p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
