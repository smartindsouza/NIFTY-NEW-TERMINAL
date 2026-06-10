import fs from 'fs';

const files = [
  'src/components/DiagnosticsPanel.tsx',
  'src/pages/TerminalControl.tsx',
  'src/pages/HistoricalAnalytics.tsx',
  'src/pages/Notifications.tsx',
  'src/pages/AiAnalysis.tsx'
];

const patterns = [
  { p: /bg-\[#121824\]\/60/g, r: 'bg-card' },
  { p: /bg-\[#121824\]\/90/g, r: 'bg-card' },
  { p: /bg-\[#121824\]/g, r: 'bg-card' },
  { p: /bg-\[#1a1b23\]/g, r: 'bg-card' },
  { p: /bg-\[#13151a\]/g, r: 'bg-background' },
  { p: /bg-slate-900\/60/g, r: 'bg-card' }
];

files.forEach(file => {
  if (fs.existsSync(file)) {
    let content = fs.readFileSync(file, 'utf8');
    patterns.forEach(({ p, r }) => {
      content = content.replace(p, r);
    });
    fs.writeFileSync(file, content, 'utf8');
  }
});

console.log('Colors fixed');
