const fs = require('fs');
let content = fs.readFileSync('src/pages/AdvancedChart.tsx', 'utf8');

// 1. Remove rsiOverbought2 and rsiOversold2 state declarations
content = content.replace(/  const \[rsiOverbought2, setRsiOverbought2\].*?  \}\);\n\n/sm, '');
content = content.replace(/  const \[rsiOversold2, setRsiOversold2\].*?  \}\);\n\n/sm, '');

// 2. Remove localStorage useEffects for these
content = content.replace(/  useEffect\(\(\) => \{\n    try \{\n      localStorage\.setItem\('rsiOverbought2V2', String\(rsiOverbought2\)\);\n    \} catch\(e\) \{\}\n  \}, \[rsiOverbought2\]\);\n\n/sm, '');
content = content.replace(/  useEffect\(\(\) => \{\n    try \{\n      localStorage\.setItem\('rsiOversold2V2', String\(rsiOversold2\)\);\n    \} catch\(e\) \{\}\n  \}, \[rsiOversold2\]\);\n\n/sm, '');

// 3. Remove them from dependency array of the massive useEffect
content = content.replace(/, rsiOverbought2, rsiOversold, rsiOversold2/g, ', rsiOversold');

// 4. Remove them from rsiLevels array
content = content.replace(/      \{ price: rsiOversold2, color: hexToRgba\(rsiOversoldColor, 0\.25\) \}, \/\/ OS 2 \(outer\)\n/g, '');
content = content.replace(/      \{ price: rsiOverbought2, color: hexToRgba\(rsiOverboughtColor, 0\.25\) \} \/\/ OB 2 \(outer\)\n/g, '');
content = content.replace(/      \{ price: rsiOverbought, color: hexToRgba\(rsiOverboughtColor, 0\.45\) \}, \/\/ OB 1 \(inner\)/g, '      { price: rsiOverbought, color: hexToRgba(rsiOverboughtColor, 0.45) } // OB');

// 5. RsiEditorModal props and signatures
content = content.replace(/  initialOverbought2,\n/g, '');
content = content.replace(/  initialOversold2,\n/g, '');
content = content.replace(/  initialOverbought2: number,\n/g, '');
content = content.replace(/  initialOversold2: number,\n/g, '');
content = content.replace(/    overbought2: number,\n/g, '');
content = content.replace(/    oversold2: number,\n/g, '');
content = content.replace(/  const \[overbought2, setOverbought2\] = useState\(initialOverbought2\);\n/g, '');
content = content.replace(/  const \[oversold2, setOversold2\] = useState\(initialOversold2\);\n/g, '');

content = content.replace(/overbought, overbought2, oversold, oversold2,/g, 'overbought, oversold,');

// 6. JSX inside RsiEditorModal
content = content.replace(/            <div className="grid grid-cols-2 gap-3">\n              <div className="flex flex-col gap-1">\n                <span className="text-xs text-foreground\/80">Level 1 \(Inner\):<\/span>/g,
                          `            <div className="flex flex-col gap-1">
                <span className="text-xs text-foreground/80">Value:</span>`);

content = content.replace(/              <\/div>\n              <div className="flex flex-col gap-1">\n                <span className="text-xs text-foreground\/80">Level 2 \(Outer\):<\/span>.*?<\/div>\n            <\/div>/gims, '              </div>');

// Remove initialOverbought2={rsiOverbought2} etc from JSX
content = content.replace(/          initialOverbought2=\{rsiOverbought2\}\n/g, '');
content = content.replace(/          initialOversold2=\{rsiOversold2\}\n/g, '');

// setRsiOverbought2(overbought2); etc usage in onApply/onChange
content = content.replace(/            setRsiOverbought2\(overbought2\);\n/g, '');
content = content.replace(/            setRsiOversold2\(oversold2\);\n/g, '');

// Update the parameter list in onApply / onChange arrow functions in <RsiEditorModal />
content = content.replace(/\(color, lineWidth, lineStyle, smaLineWidth, smaLineStyle, overbought, overbought2, oversold, oversold2, /g, '(color, lineWidth, lineStyle, smaLineWidth, smaLineStyle, overbought, oversold, ');

fs.writeFileSync('src/pages/AdvancedChart.tsx', content);
console.log("Done");
