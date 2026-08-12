export type ReplyLanguage = 'english' | 'tagalog' | 'taglish';

const TAGALOG_MARKERS =
  /\b(ang|ng|sa|ko|mo|ba|po|ho|naman|yung|mga|paano|ano|magkano|saan|kailan|bakit|sino|kami|kayo|sila|ito|iyan|yun|hindi|oo|salamat|pasensya|opo|edi|lang|din|rin|tayo|natin|nila|niya|para|kung|pero|gusto|tanong|tungkol|pwede|paki|po\b)\b/gi;

const ENGLISH_MARKERS =
  /\b(the|is|are|was|were|what|where|when|why|how|who|can|could|would|should|do|does|did|have|has|had|please|thanks|thank|hello|hi|hey|contact|price|pricing|start|about|help|want|need|this|that|here|there|your|my|our|their|its|it's|with|for|from|get|tell|show|find|much|many|demo|quote|email|phone|support)\b/gi;

/** Guess reply language from the user's latest message. */
export function detectReplyLanguage(text: string): ReplyLanguage {
  const sample = text.trim().toLowerCase();
  if (!sample) return 'english';

  const tagalogMatches = (sample.match(TAGALOG_MARKERS) ?? []).length;
  const englishMatches = (sample.match(ENGLISH_MARKERS) ?? []).length;

  if (tagalogMatches >= 1 && englishMatches >= 1) return 'taglish';
  if (tagalogMatches >= 1) return 'tagalog';
  if (englishMatches >= 1) return 'english';

  // Short/ambiguous text with no markers — default English for Latin script.
  return 'english';
}

export function replyLanguageInstruction(language: ReplyLanguage): string {
  switch (language) {
    case 'english':
      return 'IMPORTANT — Current turn: The user wrote in ENGLISH. Reply in ENGLISH only. Do not use Tagalog words or sentences.';
    case 'tagalog':
      return 'IMPORTANT — Current turn: The user wrote in TAGALOG. Reply in TAGALOG only. Do not use English sentences (product names like QuickPawn are OK).';
    case 'taglish':
      return 'IMPORTANT — Current turn: The user wrote in TAGLISH. Reply in TAGLISH with a similar mix of English and Tagalog.';
  }
}
