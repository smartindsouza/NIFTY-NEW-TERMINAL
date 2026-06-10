import { useState, useEffect, useRef } from 'react';
import { useQuery } from '@tanstack/react-query';
import axios from 'axios';
import { ExternalLink, Info, CheckCircle2, Key, Sparkles, LogOut } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useLocation } from 'wouter';

export function KiteLogin() {
  const [, setLocation] = useLocation();
  const [requestToken, setRequestToken] = useState('');
  const [isAuthenticating, setIsAuthenticating] = useState(false);
  const [error, setError] = useState('');
  
  const { data: authStatus, refetch } = useQuery({
    queryKey: ['auth-status'],
    queryFn: async () => {
      const res = await axios.get('/api/auth/status');
      return res.data;
    }
  });

  const hasProcessedRef = useRef(false);

  // Handle callback redirect automatically if the URL has ?request_token=... or errors
  useEffect(() => {
    if (hasProcessedRef.current) return;
    
    const urlParams = new URLSearchParams(window.location.search);
    const token = urlParams.get('request_token');
    const status = urlParams.get('status');
    const message = urlParams.get('message');

    if (token) {
      hasProcessedRef.current = true;
      handleManualAuth(token);
      window.history.replaceState({}, document.title, '/kite-login');
    } else if (status === 'error' && message) {
      hasProcessedRef.current = true;
      setError(decodeURIComponent(message));
      window.history.replaceState({}, document.title, '/kite-login');
    }
  }, []);

  const handleManualAuth = async (token = requestToken) => {
    if (!token) {
      setError('Please enter a request token');
      return;
    }
    
    setIsAuthenticating(true);
    setError('');
    
    try {
      await axios.post('/api/auth/manual', { request_token: token });
      await refetch();
      setLocation('/');
    } catch (err: any) {
      setError(err.response?.data?.error || 'Failed to authenticate');
    } finally {
      setIsAuthenticating(false);
    }
  };

  const handleSimulateAuth = async () => {
    setIsAuthenticating(true);
    setError('');
    
    try {
      await axios.post('/api/auth/simulate');
      await refetch();
      setLocation('/');
    } catch (err: any) {
      setError(err.response?.data?.error || 'Failed to activate simulation sandbox session');
    } finally {
      setIsAuthenticating(false);
    }
  };

  const handleDisconnect = async () => {
    try {
      await axios.post('/api/auth/disconnect');
      await refetch();
    } catch (err: any) {
      setError('Failed to disconnect active session');
    }
  };

  const appUrl = window.location.origin + '/kite-login';

  return (
    <div className="p-8 max-w-[1600px] w-full mx-auto animate-in fade-in duration-500">
      <div className="mb-8">
        <h1 className="text-3xl font-bold tracking-tight text-foreground mb-2">Zerodha Kite Connect</h1>
        <p className="text-muted-foreground">
          Authenticate with Kite to get real option chain data — live OI, IV, volume, LTP for every strike.
        </p>
      </div>

      <div className="space-y-6">
        <Card className="bg-card border-0 relative overflow-hidden">
          <div className="absolute top-0 left-0 w-1 h-full bg-primary/50"></div>
          <CardHeader>
            <div className="flex items-center gap-3">
              <div className="w-6 h-6 rounded-full bg-primary/20 text-primary flex items-center justify-center text-sm font-bold">1</div>
              <CardTitle className="text-lg">Set your redirect URL in Kite developer console</CardTitle>
            </div>
          </CardHeader>
          <CardContent className="space-y-4">
            <p className="text-sm text-muted-foreground">
              Go to <a href="https://developers.kite.trade" target="_blank" rel="noreferrer" className="text-primary hover:underline">developers.kite.trade</a>, open your app, and set the redirect URL to this app's <code className="bg-muted px-1.5 py-0.5 rounded text-primary">/kite-login</code> page:
            </p>
            <div className="bg-background rounded-md p-3 border border-0 font-mono text-sm text-primary break-all select-all">
              {appUrl}
            </div>
            <p className="text-sm text-muted-foreground">
              Copy the above URL and paste it as the redirect URL in your Kite app settings. After saving, come back here and click Login.
            </p>
          </CardContent>
        </Card>

        <Card className="bg-card border-0 relative overflow-hidden">
          <div className="absolute top-0 left-0 w-1 h-full bg-primary/50"></div>
          <CardHeader>
            <div className="flex items-center gap-3">
              <div className="w-6 h-6 rounded-full bg-primary/20 text-primary flex items-center justify-center text-sm font-bold">2</div>
              <CardTitle className="text-lg">Login with Zerodha</CardTitle>
            </div>
            {error && (
              <div className="mt-4 p-3 bg-red-500/10 border border-red-500/20 rounded-md text-sm text-red-500 flex items-start gap-2">
                 <Info className="w-4 h-4 mt-0.5 shrink-0" />
                 <p>{error}</p>
              </div>
            )}
          </CardHeader>
          <CardContent className="space-y-6">
            <p className="text-sm text-muted-foreground">
              After setting the redirect URL, click below. Kite will redirect you back here automatically with your token — no copy-pasting needed.
            </p>
            
            {authStatus?.status === 'connected' ? (
              <div className="flex flex-col items-start gap-3">
                <Button variant="outline" className={authStatus.simulated ? "bg-emerald-500/10 text-emerald-500 border-emerald-500/20 hover:bg-emerald-500/20 pointer-events-none" : "bg-green-500/10 text-green-500 border-green-500/20 hover:bg-green-500/20 pointer-events-none"}>
                  <CheckCircle2 className="w-4 h-4 mr-2" />
                  Kite Connected Successfully {authStatus.simulated ? "(Simulated Demo Sandbox)" : "(Live)"}
                </Button>
                <p className="text-xs text-muted-foreground mb-2">
                  {authStatus.simulated 
                    ? "Interactive Sandbox Mode is active. Live option chain quotes, reporting books, and mock order routers are powered by high-fidelity simulated feeds." 
                    : "Your live Zerodha Kite session is authenticated and active for today."}
                </p>
                <div className="flex flex-wrap gap-3">
                  <Button onClick={() => setLocation('/')} className="bg-primary text-primary-foreground hover:bg-primary/90">
                    Go to Dashboard
                  </Button>
                  <Button variant="outline" onClick={handleDisconnect} className="border-0 text-muted-foreground hover:text-foreground">
                    <LogOut className="w-4 h-4 mr-2" />
                    Disconnect Session
                  </Button>
                </div>
              </div>
            ) : (
              <div className="flex flex-col items-start gap-4">
                <div className="flex flex-wrap items-center gap-4 w-full">
                  <Button 
                    onClick={() => {
                      if (authStatus?.loginUrl) window.location.href = authStatus.loginUrl;
                    }}
                    disabled={!authStatus?.loginUrl}
                    className="bg-primary text-primary-foreground hover:bg-primary/90"
                  >
                    <ExternalLink className="w-4 h-4 mr-2" />
                    Connect Active Zerodha Account
                  </Button>
                  
                  <Button
                    variant="outline"
                    onClick={handleSimulateAuth}
                    disabled={isAuthenticating}
                    className="border-emerald-500/30 text-emerald-500 bg-emerald-500/5 hover:bg-emerald-500/10 hover:text-emerald-400"
                  >
                    <Sparkles className="w-4 h-4 mr-2" />
                    Activate High-Fidelity Simulator
                  </Button>
                </div>
                {authStatus?.loginUrl && (
                  <p className="text-xs text-muted-foreground font-mono">
                    API Key in use: {authStatus.loginUrl.split('api_key=')[1]?.split('&')[0]?.substring(0, 6)}...
                  </p>
                )}
                {!authStatus?.loginUrl && (
                  <p className="text-xs text-muted-foreground">
                    KITE_API_KEY environment variable is not defined on the server. If you don't have premium Kite developer credentials, simply click <span className="text-emerald-400 font-medium font-sans">Activate High-Fidelity Simulator</span> to test and run the full application!
                  </p>
                )}
              </div>
            )}
          </CardContent>
        </Card>

        <Card className="bg-card border-0 relative overflow-hidden">
          <div className="absolute top-0 left-0 w-1 h-full bg-primary/50"></div>
          <CardHeader>
             <div className="flex items-center gap-3">
              <div className="w-6 h-6 rounded-full bg-primary/20 text-primary flex items-center justify-center text-sm font-bold">3</div>
              <CardTitle className="text-lg">Manual fallback — paste token directly</CardTitle>
            </div>
            <CardDescription className="pt-2">If the redirect didn't work or you already have a token from another source.</CardDescription>
          </CardHeader>
          <CardContent>
            <Tabs defaultValue="request_token" className="w-full mt-2">
              <TabsList className="mb-4 bg-background">
                <TabsTrigger value="request_token" className="data-[state=active]:bg-card rounded-full px-6">Request Token</TabsTrigger>
                <TabsTrigger value="access_token" className="data-[state=active]:bg-card rounded-full px-6 opacity-50 cursor-not-allowed">Access Token</TabsTrigger>
              </TabsList>
              <TabsContent value="request_token" className="space-y-4">
                <div className="flex items-start gap-3 p-3 bg-secondary/30 rounded-md border border-0">
                  <Info className="w-5 h-5 text-primary mt-0.5 shrink-0" />
                  <p className="text-xs text-muted-foreground leading-relaxed">
                    From the redirect URL, copy the <span className="text-primary font-mono">request_token</span> value:<br />
                    <span className="font-mono opacity-60">...?request_token=</span><span className="text-primary font-mono font-bold">PASTE_THIS</span><span className="font-mono opacity-60">&action=login&status=success</span>
                  </p>
                </div>
                
                <div className="space-y-2">
                  <Input 
                    placeholder="Paste request_token here..." 
                    type="password"
                    value={requestToken}
                    onChange={(e) => setRequestToken(e.target.value)}
                    className="bg-background border-0/20 font-mono"
                  />
                  {error && <p className="text-xs text-red-500">{error}</p>}
                </div>
                
                <Button 
                  onClick={() => handleManualAuth()} 
                  disabled={!requestToken || isAuthenticating}
                  className="bg-muted text-foreground hover:bg-muted/80"
                >
                  {isAuthenticating ? 'Authenticating...' : 'Authenticate'}
                </Button>
              </TabsContent>
            </Tabs>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
