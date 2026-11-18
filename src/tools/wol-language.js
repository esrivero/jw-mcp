const LANGUAGES = {
  E: { langwritten: 'E', locale: 'en', region: 'r1', library: 'lp-e' },
  S: { langwritten: 'S', locale: 'es', region: 'r4', library: 'lp-s' },
  F: { langwritten: 'F', locale: 'fr', region: 'r30', library: 'lp-f' },
  X: { langwritten: 'X', locale: 'de', region: 'r10', library: 'lp-x' },
  I: { langwritten: 'I', locale: 'it', region: 'r6', library: 'lp-i' },
  T: { langwritten: 'T', locale: 'pt', region: 'r5', library: 'lp-t' },
  J: { langwritten: 'J', locale: 'ja', region: 'r7', library: 'lp-j' },
  KO: { langwritten: 'KO', locale: 'ko', region: 'r8', library: 'lp-ko' },
  U: { langwritten: 'U', locale: 'ru', region: 'r2', library: 'lp-u' },
};
const DEFAULT_LANGUAGE = (process.env.DEFAULT_LANGUAGE || 'E').toUpperCase();
function getWolLanguage(langwritten = DEFAULT_LANGUAGE) {
  const normalized = String(langwritten || DEFAULT_LANGUAGE).toUpperCase();
  const language = LANGUAGES[normalized];
  if (!language) {
    throw new Error(
      `Unsupported WOL langwritten code "${langwritten}". Supported codes: ${Object.keys(LANGUAGES).join(', ')}`,
    );
  }
  return language;
}
function wolPath(type, tail, langwritten) {
  const language = getWolLanguage(langwritten);
  const suffix = tail ? `/${tail.replace(/^\/+/, '')}` : '';
  return `https://wol.jw.org/${language.locale}/wol/${type}/${language.region}/${language.library}${suffix}`;
}
function normalizeLangwritten(langwritten, language) {
  return (langwritten || language || DEFAULT_LANGUAGE).toUpperCase();
}
export { getWolLanguage, normalizeLangwritten, wolPath };
