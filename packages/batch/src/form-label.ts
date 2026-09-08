/**
 * Poem forms, named in Vietnamese.
 *
 * The corpus and the verifier name forms in Chinese, which is right for the trace but not for
 * a spreadsheet column read by someone who does not read it. The export therefore carries the
 * form twice: `han_form` keeps the stable internal code, which is what a script should join
 * on, and `han_form_label` carries the Sino-Vietnamese name a person can read.
 *
 * WHY THE MAP LIVES HERE rather than beside `FORM_LABEL` in packages/retrieval: this package
 * does not depend on retrieval, and adding that dependency to reach one table would pull the
 * whole retrieval layer — drizzle, the vector client — into a package that reads spreadsheets.
 * The cost of the copy is drift, so a test in apps/api, the one package that can see both,
 * asserts every form the verifier can produce has a name here.
 */

export const FORM_LABEL_VI: Record<string, string> = {
  wujue: 'ngũ ngôn tứ tuyệt',
  qijue: 'thất ngôn tứ tuyệt',
  wulu: 'ngũ ngôn bát cú',
  qilu: 'thất ngôn bát cú',
  wupai: 'ngũ ngôn bài luật',
  qipai: 'thất ngôn bài luật',
  gushi: 'cổ thi',
  ci: 'từ',
  unknown: 'chưa rõ',
};

/**
 * The readable name, or the code itself when the code is one this table has not been taught.
 *
 * Falling back to the code rather than to empty: an unknown form is a gap in this table, and
 * printing the raw code says so, where a blank cell would read as "the poem has no form".
 */
export const formLabelVi = (form: string | null | undefined): string | null =>
  form ? (FORM_LABEL_VI[form] ?? form) : null;
