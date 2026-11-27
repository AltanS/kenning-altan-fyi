/**
 * A language named in the language of the interface, for the Rooms screens.
 *
 * THIS DIFFERS FROM `languageName` ON PURPOSE. The history and favourites rows
 * name a language natively. A room is asked for in a sentence ("German words,
 * explained in English"), and a sentence has one language.
 *
 * `Intl.DisplayNames` answers the same on the server and in the browser for the
 * served languages, so the first render and hydration agree.
 */

export interface LocalizedLanguageNameParams {
  /** A language code, for example `de`. */
  code: string;
  /** The interface language the name is written in. */
  uiLanguage: string;
}

export function localizedLanguageName({ code, uiLanguage }: LocalizedLanguageNameParams): string {
  const names = new Intl.DisplayNames([uiLanguage], { type: 'language', fallback: 'code' });
  return names.of(code) ?? code;
}
