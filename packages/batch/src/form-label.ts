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

export const formLabelVi = (form: string | null | undefined): string | null =>
  form ? (FORM_LABEL_VI[form] ?? form) : null;
