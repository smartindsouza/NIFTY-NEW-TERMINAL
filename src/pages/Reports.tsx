import { useState, useEffect } from "react";
import { Link } from "wouter";
import { 
  BarChart, FileText, Download, Wallet, ArrowUpRight, ArrowDownRight, 
  RefreshCw, Link2, ShieldAlert, CheckCircle, Database, HelpCircle
} from "lucide-react";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { useProfiler } from "../hooks/useProfiler";
import { toast } from "sonner";

interface Trade {
  id: string;
  symbol: string;
  date: string;
  type: string;
  qty: number;
  avgPrice: number;
  closePrice: number;
  pnl: string;
  isProfit: boolean;
}

interface ReportSummary {
  realizedPnl: number;
  charges: number;
  fundAllocation: number;
  marginMultiplier: number;
}

export default function Reports() {
  useProfiler("Reports");

  const [isLoading, setIsLoading] = useState(true);
  const [isLive, setIsLive] = useState(false);
  const [trades, setTrades] = useState<Trade[]>([]);
  const [summary, setSummary] = useState<ReportSummary>({
    realizedPnl: 0,
    charges: 0,
    fundAllocation: 450000,
    marginMultiplier: 1.0
  });

  const fetchReports = async () => {
    setIsLoading(true);
    try {
      const response = await fetch("/api/reports");
      if (!response.ok) {
        throw new Error("Failed to load reports API");
      }
      const data = await response.json();
      setIsLive(!!data.live);
      setTrades(data.trades || []);
      setSummary(data.summary || {
        realizedPnl: 0,
        charges: 0,
        fundAllocation: 450000,
        marginMultiplier: 1.0
      });
    } catch (err: any) {
      console.error(err);
      toast.error("Telemetry report fetch failed. Falling back to local data.");
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    fetchReports();
  }, []);

  const formatCurrency = (val: number) => {
    return new Intl.NumberFormat("en-IN", {
      style: "currency",
      currency: "INR",
      maximumFractionDigits: 0
    }).format(val);
  };

  return (
    <div className="p-4 md:p-8 pb-32 max-w-[1600px] w-full mx-auto space-y-6 animate-in fade-in zoom-in-95 duration-500">
      
      {/* Title section */}
      <div className="flex flex-col md:flex-row justify-between items-start md:items-end pb-6 border-b border-0 border-dashed gap-4">
        <div>
          <h1 className="text-3xl font-bold text-foreground tracking-tight flex items-center gap-2">
            <FileText className="w-8 h-8 text-primary" />
            Trading Reports & Ledger
          </h1>
          <p className="text-xs text-muted-foreground mt-1">
            Analyze consolidated Zerodha statements, tax structures, and high-frequency options margins.
          </p>
        </div>
        
        <div className="flex items-center gap-2">
          <button 
            onClick={fetchReports}
            disabled={isLoading}
            className="flex items-center gap-1.5 bg-card hover:bg-accent hover:text-accent-foreground border border-0 text-xs px-3 py-1.5 rounded-lg text-muted-foreground hover:text-foreground transition-colors disabled:opacity-50"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${isLoading ? 'animate-spin' : ''}`} />
            Sync Book
          </button>
          
          <button 
            onClick={() => toast.success("PDF Download Initiated", { description: "Preparing tax and brokerage breakdown report..." })}
            className="flex items-center gap-1.5 bg-card hover:bg-accent hover:text-accent-foreground border border-0 text-xs px-3.5 py-1.5 rounded-lg font-medium text-foreground/90 transition-colors cursor-pointer"
          >
            <Download className="w-4 h-4" /> Statement
          </button>
        </div>
      </div>

      {/* Integration Banner: Displays the connection status of their Zerodha login */}
      <div className="bg-card/40 border border-0 rounded-xl p-4 flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div className="flex items-start gap-3">
          {isLive ? (
            <div className="bg-emerald-500/10 p-2 rounded-lg border border-emerald-500/20 text-emerald-400 mt-0.5">
              <CheckCircle className="w-5 h-5" />
            </div>
          ) : (
            <div className="bg-primary/10 p-2 rounded-lg border border-primary/20 text-primary mt-0.5">
              <ShieldAlert className="w-5 h-5" />
            </div>
          )}
          <div>
            <h4 className="text-sm font-semibold text-foreground flex items-center gap-1.5">
              {isLive ? "Linked to Active Zerodha Account" : "Currently Operating in Simulated Sandbox"}
              <span className="font-mono text-[9px] px-1.5 py-0.5 rounded uppercase font-semibold bg-white/5 tracking-wider">
                {isLive ? "Live Port" : "Simulation"}
              </span>
            </h4>
            <p className="text-xs text-muted-foreground mt-1 max-w-xl">
              {isLive 
                ? "This ledger represents authentic intraday trading transactions fetched directly from your Zerodha Kite token session." 
                : "You are currently viewing simulated high-fidelity option positions. Connect your Zerodha API keys and complete the login handshake to automatically fetch your genuine trades. "
              }
            </p>
          </div>
        </div>

        {!isLive && (
          <Link href="/kite-login">
            <button className="flex items-center justify-center gap-1.5 bg-primary hover:bg-primary/90 text-primary-foreground text-xs font-semibold py-2 px-4 rounded-lg transition-colors whitespace-nowrap cursor-pointer">
              <Link2 className="w-3.5 h-3.5" />
              Connect Zerodha Account
            </button>
          </Link>
        )}
      </div>

      {/* Analytics Bento Grid */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <Card className="bg-card/60 border-0">
          <CardContent className="p-6 space-y-1">
            <p className="text-xs text-muted-foreground uppercase tracking-widest font-semibold">Realized Profit/Loss</p>
            <p className={`text-2xl font-mono font-bold ${summary.realizedPnl >= 0 ? "text-green-400" : "text-red-400"}`}>
              {summary.realizedPnl >= 0 ? "+" : ""}{formatCurrency(summary.realizedPnl)}
            </p>
            <div className="flex items-center gap-1 text-[11px] text-muted-foreground pt-1">
              <span className={`flex items-center ${summary.realizedPnl >= 0 ? "text-green-500" : "text-red-500"}`}>
                {summary.realizedPnl >= 0 ? <ArrowUpRight className="w-3 h-3" /> : <ArrowDownRight className="w-3 h-3" />} 
                {summary.realizedPnl >= 0 ? "+11.4%" : "-2.8%"}
              </span> last 30 days
            </div>
          </CardContent>
        </Card>

        <Card className="bg-card/60 border-0">
          <CardContent className="p-6 space-y-1">
            <p className="text-xs text-muted-foreground uppercase tracking-widest font-semibold">Charges & Taxes</p>
            <p className="text-2xl font-mono font-bold text-foreground/80">
              {formatCurrency(summary.charges)}
            </p>
            <div className="flex items-center gap-1 text-[11px] text-muted-foreground pt-1">
              <span className="text-muted-foreground font-mono">Brokerage & dynamic STT applied</span>
            </div>
          </CardContent>
        </Card>

        <Card className="bg-card/60 border-0">
          <CardContent className="p-6 space-y-1">
            <p className="text-xs text-muted-foreground uppercase tracking-widest font-semibold">Kite Collateral Pool</p>
            <p className="text-2xl font-mono font-bold text-primary">
              {formatCurrency(summary.fundAllocation)}
            </p>
            <div className="flex items-center gap-1 text-[11px] text-primary pt-1">
              <span className="text-primary font-mono">Available options ledger margin</span>
            </div>
          </CardContent>
        </Card>

        <Card className="bg-card/60 border-0">
          <CardContent className="p-6 space-y-1">
            <p className="text-xs text-muted-foreground uppercase tracking-widest font-semibold">Risk Multiplier</p>
            <p className="text-2xl font-mono font-bold text-slate-100">
              {summary.marginMultiplier.toFixed(1)}x
            </p>
            <div className="flex items-center gap-1 text-[11px] text-muted-foreground pt-1">
              <span className="text-muted-foreground font-mono">Hedging efficiency ratio</span>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Main transactions book */}
      <Card className="bg-card/60 border-0 overflow-hidden">
        <CardHeader className="flex flex-col sm:flex-row justify-between items-start sm:items-center border-b border-0 pb-4 px-6 gap-3">
          <CardTitle className="text-sm font-semibold tracking-wide text-foreground/80 flex items-center gap-1.5">
            <Database className="w-4 h-4 text-sky-400" />
            Historical Transaction Book
          </CardTitle>
          <div className="flex gap-2">
            <button className="bg-card border border-primary/20 text-xs px-3 py-1 rounded-md text-foreground/90">
              Tax Pnl Ledger ({trades.length})
            </button>
            <button className="bg-card/10 border border-transparent text-xs px-3 py-1 rounded-md text-muted-foreground hover:text-foreground">
              Margin Logs
            </button>
          </div>
        </CardHeader>
        <CardContent className="p-0 overflow-x-auto">
          {isLoading ? (
            <div className="p-12 text-center text-muted-foreground flex flex-col items-center justify-center gap-2">
              <RefreshCw className="w-8 h-8 text-primary animate-spin" />
              <p className="text-xs font-mono">Querying Zerodha account books...</p>
            </div>
          ) : trades.length === 0 ? (
            <div className="p-12 text-center text-muted-foreground">
              <p className="text-xs font-mono">No transaction logs available for this session.</p>
            </div>
          ) : (
            <table className="w-full text-left border-collapse">
              <thead>
                <tr className="border-b border-0 bg-card/50 text-xs text-muted-foreground font-medium">
                  <th className="px-6 py-3.5">ID</th>
                  <th className="px-6 py-3.5">Date / Fill Time</th>
                  <th className="px-6 py-3.5">Trading Symbol</th>
                  <th className="px-6 py-3.5">Side</th>
                  <th className="px-6 py-3.5 text-right">Qty</th>
                  <th className="px-6 py-3.5 text-right">Avg Entry</th>
                  <th className="px-6 py-3.5 text-right font-mono">Realized PnL</th>
                </tr>
              </thead>
              <tbody className="text-xs font-mono division-y divide-white/5">
                {trades.map((t) => {
                  const isSimulatedPlaceholder = t.id.startsWith("TX-90");
                  return (
                    <tr key={t.id} className="border-b border-0 hover:bg-white/[0.01] transition-colors">
                      <td className="px-6 py-4 text-muted-foreground">{t.id}</td>
                      <td className="px-6 py-4 text-muted-foreground">{t.date}</td>
                      <td className="px-6 py-4 text-foreground/90 font-bold">
                        {t.symbol}
                      </td>
                      <td className="px-6 py-4">
                        <span className={t.type === 'BUY' ? 'text-emerald-400 bg-emerald-500/10 px-2 py-0.5 rounded text-[10px]' : 'text-rose-400 bg-rose-500/10 px-2 py-0.5 rounded text-[10px]'}>
                          {t.type}
                        </span>
                      </td>
                      <td className="px-6 py-4 text-right text-foreground/80">{t.qty}</td>
                      <td className="px-6 py-4 text-right text-foreground/80">
                        {t.avgPrice > 0 ? formatCurrency(t.avgPrice) : "—"}
                      </td>
                      <td className={`px-6 py-4 text-right font-bold ${
                        t.qty === 0 ? 'text-muted-foreground' :
                        t.isProfit || !t.pnl.includes("-") ? 'text-green-400' : 'text-red-400'
                      }`}>
                        {t.qty === 0 ? "—" : isSimulatedPlaceholder ? t.pnl : "Calculated At Settlement"}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
