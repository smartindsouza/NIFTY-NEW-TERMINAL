const fs = require('fs');
let content = fs.readFileSync('src/pages/AdvancedChart.tsx', 'utf8');

content = content.replace("ctx.fillText('MKT CLOSED', x + badgeWidth / 2, badgeY + badgeHeight / 2);", "ctx.fillText('CLOSED', x + badgeWidth / 2, badgeY + badgeHeight / 2);");

// Spot Price Badge
content = content.replace(
    "ctx.fillRect(x, spotY, badgeWidth, badgeHeight);", 
    "ctx.beginPath();\\n            ctx.roundRect(x, spotY, badgeWidth, badgeHeight, badgeHeight / 2);\\n            ctx.fill();"
);

// Countdown/Closed Badge
content = content.replace(
    "ctx.fillRect(x, badgeY, badgeWidth, badgeHeight);", 
    "ctx.beginPath();\\n              ctx.roundRect(x, badgeY, badgeWidth, badgeHeight, badgeHeight / 2);\\n              ctx.fill();"
);

// Label (SUP/RES) Pill Background
content = content.replace(
    "ctx.fillRect(bgX, bgY, totalWidth, totalHeight);", 
    "ctx.beginPath();\\n                 ctx.roundRect(bgX, bgY, totalWidth, totalHeight, totalHeight / 2);\\n                 ctx.fill();"
);

// Crosshair label
content = content.replace(
    "ctx.fillRect(x, labelY, priceScaleWidth, labelHeight);", 
    "ctx.beginPath();\\n            ctx.roundRect(x, labelY, priceScaleWidth, labelHeight, 4);\\n            ctx.fill();"
);

fs.writeFileSync('src/pages/AdvancedChart.tsx', content);
console.log('Fixed fillRects');
