function isAsciiChar(char) {
  return char.charCodeAt(0) <= 127;
}

function countChars(text) {
  let asciiCount = 0;
  let otherCount = 0;
  for (let i = 0; i < text.length; i++) {
    if (isAsciiChar(text[i])) {
      asciiCount++;
    } else {
      otherCount++;
    }
  }
  return { asciiCount, otherCount, total: text.length };
}

function truncateForButton(text, maxLength = 10) {
  if (!text || text.length <= maxLength) {
    return text || "";
  }
  return text.substring(0, maxLength) + "...";
}

function limitInputLength(text, maxAscii = 40, maxOther = 10) {
  if (!text) return "";

  let asciiCount = 0;
  let otherCount = 0;
  let result = "";

  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (isAsciiChar(char)) {
      if (asciiCount >= maxAscii) break;
      asciiCount++;
      result += char;
    } else {
      if (otherCount >= maxOther) break;
      otherCount++;
      result += char;
    }
  }

  return result;
}

module.exports = { isAsciiChar, countChars, truncateForButton, limitInputLength };
