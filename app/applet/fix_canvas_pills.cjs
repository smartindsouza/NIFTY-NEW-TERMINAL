const fs = require('fs');
let content = fs.readFileSync('src/pages/AdvancedChart.tsx', 'utf8');

content = content.replace("ctx.fillText('MKT CLOSED', x + badgeWidth / 2, badgeY + badgeHeight / 2);", "ctx.fillText('CLOSED', x + badgeWidth / 2, badgeY + badgeHeight / 2);");

// Label (SUP/RES) Pill Background
content = content.replace(
    "ctx.fillRect(bgX, bgY, totalWidth, totalHeight);", 
    "ctx.beginPath();\n                 ctx.roundRect(bgX, bgY, totalWidth, totalHeight, totalHeight / 2);\n                 ctx.fill();"
);

fs.writeFileSync('src/pages/AdvancedChart.tsx', content);
console.log('Fixed pill backgrounds & CLOSED text');
