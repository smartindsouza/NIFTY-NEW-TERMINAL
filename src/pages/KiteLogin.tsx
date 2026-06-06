import { useState, useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import axios from 'axios';
import { ExternalLink, Info, CheckCircle2, Key } from 'lucide-react';
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

  // Handle callback redirect automatically if the URL has ?request_token=...
  useEffect(() => {
    const urlParams = new URLSearchParams(window.location.search);
    const token = urlParams.get('request_token');
    if (token) {
      handleManualAuth(token);
      // Clean up URL
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

  const appUrl = window.location.origin + '/kite-login';

  return (
    <div className="p-8 max-w-[1200px] w-full mx-auto animate-in fade-in duration-500">
      <div className="mb-8">
        <h1 className="text-3xl font-bold tracking-tight text-foreground mb-2">Zerodha Kite Connect</h1>
        <p className="text-muted-foreground">
          Authenticate with Kite to get real option chain data — live OI, IV, volume, LTP for every strike.
        </p>
      </div>

      <div className="space-y-6">
        <Card className="bg-card border-border/10 shadow-sm relative overflow-hidden">
          <div className="absolute top-0 left-0 w-1 h-full bg-primary/50"></div>
          <CardHeader>
            <div className="flex items-center gap-3">
              <div className="w-6 h-6 rounded-full bg-primary/20 text-primary flex items-center justify-center text-sm font-bold">1</div>
              <CardTitle className="text-lg">Set your redirect URL in Kite developer console</CardTitle>
            </div>
          </CardHeader>
          <CardContent className="space-y-4">
            <p className="text-sm text-muted-foreground">
              Go to <a href="https://developers.kite.trade" target="_blank" rel="noreferrer" className="text-primary hover:underline">developers.kite.trade</a>, open your app, and set the redirect URL to this app's <code className="bg-muted px-1.5 py-0.5 rounded text-yellow-500">/kite-login</code> page:
            </p>
            <div className="bg-background rounded-md p-3 border border-border/10 font-mono text-sm text-yellow-500 break-all select-all">
              {appUrl}
            </div>
            <p className="text-sm text-muted-foreground">
              Copy the above URL and paste it as the redirect URL in your Kite app settings. After saving, come back here and click Login.
            </p>
          </CardContent>
        </Card>

        <Card className="bg-card border-border/10 shadow-sm relative overflow-hidden">
          <div className="absolute top-0 left-0 w-1 h-full bg-primary/50"></div>
          <CardHeader>
            <div className="flex items-center gap-3">
              <div className="w-6 h-6 rounded-full bg-primary/20 text-primary flex items-center justify-center text-sm font-bold">2</div>
              <CardTitle className="text-lg">Login with Zerodha</CardTitle>
            </div>
          </CardHeader>
          <CardContent className="space-y-6">
            <p className="text-sm text-muted-foreground">
              After setting the redirect URL, click below. Kite will redirect you back here automatically with your token — no copy-pasting needed.
            </p>
            
            {authStatus?.status === 'connected' ? (
              <div className="flex flex-col items-start gap-3">
                <Button variant="outline" className="bg-green-500/10 text-green-500 border-green-500/20 hover:bg-green-500/20">
                  <CheckCircle2 className="w-4 h-4 mr-2" />
                  Kite Connected Successfully
                </Button>
                <p className="text-xs text-muted-foreground mb-2">Your session is active for today.</p>
                <Button onClick={() => setLocation('/')} className="bg-primary text-primary-foreground hover:bg-primary/90">
                  Go to Dashboard
                </Button>
              </div>
            ) : (
              <div className="flex flex-col items-start gap-4">
                <Button 
                  onClick={() => {
                    if (authStatus?.loginUrl) window.location.href = authStatus.loginUrl;
                  }}
                  disabled={!authStatus?.loginUrl}
                  className="bg-primary text-primary-foreground hover:bg-primary/90"
                >
                  <ExternalLink className="w-4 h-4 mr-2" />
                  Login with Zerodha Kite
                </Button>
                {authStatus?.loginUrl && (
                  <p className="text-xs text-muted-foreground font-mono">
                    API Key in use: {authStatus.loginUrl.split('api_key=')[1]?.split('&')[0]?.substring(0, 6)}...
                  </p>
                )}
                {!authStatus?.loginUrl && (
                  <p className="text-xs text-red-400">
                    KITE_API_KEY environment variable is missing on the server.
                  </p>
                )}
              </div>
            )}
          </CardContent>
        </Card>

        <Card className="bg-card border-border/10 shadow-sm relative overflow-hidden">
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
                <div className="flex items-start gap-3 p-3 bg-secondary/30 rounded-md border border-border/10">
                  <Info className="w-5 h-5 text-primary mt-0.5 shrink-0" />
                  <p className="text-xs text-muted-foreground leading-relaxed">
                    From the redirect URL, copy the <span className="text-yellow-500 font-mono">request_token</span> value:<br />
                    <span className="font-mono opacity-60">...?request_token=</span><span className="text-yellow-500 font-mono font-bold">PASTE_THIS</span><span className="font-mono opacity-60">&action=login&status=success</span>
                  </p>
                </div>
                
                <div className="space-y-2">
                  <Input 
                    placeholder="Paste request_token here..." 
                    type="password"
                    value={requestToken}
                    onChange={(e) => setRequestToken(e.target.value)}
                    className="bg-background border-border/20 font-mono"
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
