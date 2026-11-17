import { OptionChainView } from '../components/OptionChainSheet';

// THE OPTION CHAIN PAGE IS THE SAME CHAIN, STANDING ON ITS OWN (17 Nov 2026).
// The chain is Lemonn's now (see components/OptionChainSheet) and on a phone it
// comes up as a sheet over the chart. This address is kept for the desktop's
// side bar and for the links that already point here: it shows that same chain
// filling the page. The page that was here before — the table with the OI
// bars, the zones and the NIFTY | SENSEX switch — is gone, as Martin asked.
export function OptionChain() {
  return (
    // On a phone it ends where the app's bottom bar begins. The page it sits in
    // keeps room under itself for that bar and a little more; the little more
    // is taken back here, or the page would scroll by it.
    <div data-chain-page="" className="mx-auto w-full md:max-w-[560px] md:mt-2 h-[calc(100dvh-max(env(safe-area-inset-top),12px)-4rem-env(safe-area-inset-bottom))] max-md:-mb-8 md:h-[calc(100dvh-6rem)] md:rounded-xl md:border md:border-border overflow-hidden">
      <OptionChainView />
    </div>
  );
}
