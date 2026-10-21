// JSX typing for the <bias-panel> web component (public/bias-panel.js).
import 'react';

declare module 'react' {
  namespace JSX {
    interface IntrinsicElements {
      'bias-panel': React.DetailedHTMLProps<React.HTMLAttributes<HTMLElement>, HTMLElement> & {
        compact?: string;
        'api-key'?: string;
        base?: string;
      };
    }
  }
}
