/**
 * UI labels — the spec §17 puts Vietnamese, English and Chinese labels in scope and
 * anything beyond them out of it. So this is a flat label table, not a translation framework:
 * three languages, one file, no runtime loading.
 *
 * Step names and status words live here too. A trace that "reads like a sentence" (§14.2) has
 * to read like one in the reader's language, or it reads like a log again.
 */

import type { UiLanguage } from '@han/shared/runtime-config';

export const LANGUAGE_NAMES: Record<UiLanguage, string> = {
  vi: 'Tiếng Việt',
  en: 'English',
  zh: '中文',
};

type Dict = Record<string, string>;

const vi: Dict = {
  'app.tagline': '{n} bài · 全唐詩 + 宋詞',
  'search.placeholder': 'Dán một đoạn thơ — sai thứ tự, thiếu chữ, hay chép từ thư pháp',
  'search.button': 'Tìm',
  'search.running': 'Đang tìm…',
  'settings.title': 'Cài đặt',
  'settings.close': 'Đóng',
  'settings.reset': 'Khôi phục mặc định',
  'settings.session': 'Thay đổi ở đây chỉ áp dụng cho trình duyệt này, không ghi đè cấu hình dự án.',
  'settings.display': 'Hiển thị',
  'settings.language': 'Ngôn ngữ',
  'settings.vertical': 'Chữ dọc 直書',
  'settings.debug': 'Chế độ gỡ lỗi',
  'settings.hideSkipped': 'Ẩn bước không chạy',
  'settings.retrieval': 'Tìm kiếm',
  'settings.topK': 'Số kết quả trả về',
  'settings.fuseTopN': 'Ứng viên đưa vào xếp hạng lại',
  'settings.rrfK': 'Hằng số RRF',
  'settings.sources': 'Nguồn tham gia',
  'settings.exactAlways': 'Khớp chính xác luôn chạy — đây là tầng chính, không phải tuỳ chọn.',
  'settings.confidence': 'Ngưỡng tin cậy',
  'settings.uncalibrated': 'Các số này chưa hiệu chỉnh (§8). Đổi ở đây để thử nghiệm; đổi mặc định của dự án cần một lần hiệu chỉnh có ghi chép.',
  'settings.verifyFloor': 'Ngưỡng cần kiểm chứng',
  'settings.noiseFloor': 'Ngưỡng nhiễu',
  'settings.minLexicalOverlap': 'Tỉ lệ chữ trùng tối thiểu',
  'settings.minAgreeingWindows': 'Số cửa sổ phải đồng thuận',
  'settings.agent': 'Agent',
  'settings.enabled': 'Bật agent',
  'settings.maxIterations': 'Số vòng lặp tối đa',
  'settings.maxToolCalls': 'Số lượt gọi công cụ tối đa',
  'settings.maxWallClockMs': 'Thời gian tối đa (ms)',
  'settings.maxCostUsd': 'Chi phí tối đa (USD)',
  'settings.skipWhenNoOverlap': 'Bỏ qua agent khi không có chữ nào trùng',
  'settings.models': 'Mô hình',
  'settings.modelReasoning': 'Suy luận (chọn công cụ)',
  'settings.modelAnswer': 'Sinh câu trả lời',
  'settings.fromEnv': 'theo môi trường',
  'answer.none': 'Không có câu trả lời đáng tin',
  'answer.notAuthoritative': 'Đây là những gì kho dữ liệu này ghi, không phải bản hiệu đính có thẩm quyền.',
  'answer.horizontal': 'Chữ ngang',
  'answer.vertical': 'Chữ dọc 直書',
  'trace.inscription': 'Lạc khoản đã tách ra',
};

const en: Dict = {
  'app.tagline': '{n} poems · 全唐詩 + 宋詞',
  'search.placeholder': 'Paste a fragment — reordered, damaged, or copied from calligraphy',
  'search.button': 'Search',
  'search.running': 'Searching…',
  'settings.title': 'Settings',
  'settings.close': 'Close',
  'settings.reset': 'Reset to defaults',
  'settings.session': 'Changes here apply to this browser only and never overwrite the project configuration.',
  'settings.display': 'Display',
  'settings.language': 'Language',
  'settings.vertical': 'Vertical 直書',
  'settings.debug': 'Debug mode',
  'settings.hideSkipped': 'Hide steps that did not run',
  'settings.retrieval': 'Retrieval',
  'settings.topK': 'Results returned',
  'settings.fuseTopN': 'Candidates into the reranker',
  'settings.rrfK': 'RRF constant',
  'settings.sources': 'Sources in play',
  'settings.exactAlways': 'Exact match always runs — it is the primary retriever, not an option.',
  'settings.confidence': 'Confidence thresholds',
  'settings.uncalibrated': 'These numbers are uncalibrated (§8). Change them here to experiment; changing the project defaults needs a recorded calibration run.',
  'settings.verifyFloor': 'Verify floor',
  'settings.noiseFloor': 'Noise floor',
  'settings.minLexicalOverlap': 'Minimum character overlap',
  'settings.minAgreeingWindows': 'Windows that must agree',
  'settings.agent': 'Agent',
  'settings.enabled': 'Enable agent',
  'settings.maxIterations': 'Max iterations',
  'settings.maxToolCalls': 'Max tool calls',
  'settings.maxWallClockMs': 'Max wall clock (ms)',
  'settings.maxCostUsd': 'Max cost (USD)',
  'settings.skipWhenNoOverlap': 'Skip the agent when nothing overlaps',
  'settings.models': 'Models',
  'settings.modelReasoning': 'Reasoning (tool selection)',
  'settings.modelAnswer': 'Answer generation',
  'settings.fromEnv': 'from environment',
  'answer.none': 'No confident answer',
  'answer.notAuthoritative': 'This is what this dataset says, not an authoritative edition.',
  'answer.horizontal': 'Horizontal',
  'answer.vertical': 'Vertical 直書',
  'trace.inscription': 'Inscription set aside',
};

const zh: Dict = {
  'app.tagline': '{n} 首 · 全唐詩 + 宋詞',
  'search.placeholder': '貼上詩句片段 — 次序錯亂、缺字，或自書法轉錄皆可',
  'search.button': '檢索',
  'search.running': '檢索中…',
  'settings.title': '設定',
  'settings.close': '關閉',
  'settings.reset': '還原預設值',
  'settings.session': '此處變更僅適用於本瀏覽器，不會覆寫專案設定。',
  'settings.display': '顯示',
  'settings.language': '語言',
  'settings.vertical': '直書',
  'settings.debug': '除錯模式',
  'settings.hideSkipped': '隱藏未執行的步驟',
  'settings.retrieval': '檢索',
  'settings.topK': '回傳結果數',
  'settings.fuseTopN': '進入重排的候選數',
  'settings.rrfK': 'RRF 常數',
  'settings.sources': '參與的來源',
  'settings.exactAlways': '精確比對必定執行 — 它是主要檢索器，並非選項。',
  'settings.confidence': '信心門檻',
  'settings.uncalibrated': '這些數值尚未校準（§8）。可在此試驗；變更專案預設值須有記錄在案的校準。',
  'settings.verifyFloor': '需驗證門檻',
  'settings.noiseFloor': '雜訊門檻',
  'settings.minLexicalOverlap': '最低字元重疊比例',
  'settings.minAgreeingWindows': '須一致的視窗數',
  'settings.agent': '代理',
  'settings.enabled': '啟用代理',
  'settings.maxIterations': '最多迭代次數',
  'settings.maxToolCalls': '最多工具呼叫次數',
  'settings.maxWallClockMs': '時間上限（毫秒）',
  'settings.maxCostUsd': '費用上限（美元）',
  'settings.skipWhenNoOverlap': '無字元重疊時略過代理',
  'settings.models': '模型',
  'settings.modelReasoning': '推理（工具選擇）',
  'settings.modelAnswer': '生成答案',
  'settings.fromEnv': '取自環境變數',
  'answer.none': '沒有可信的答案',
  'answer.notAuthoritative': '這是此資料集所載，並非權威校本。',
  'answer.horizontal': '橫書',
  'answer.vertical': '直書',
  'trace.inscription': '已分離的落款',
};

const DICTS: Record<UiLanguage, Dict> = { vi, en, zh };

/** A missing key falls back to English, then to the key itself — a visible gap beats a blank. */
export function t(lang: UiLanguage, key: string, vars: Record<string, string | number> = {}): string {
  const raw = DICTS[lang][key] ?? DICTS.en[key] ?? key;
  return raw.replace(/\{(\w+)\}/gu, (m, name: string) => String(vars[name] ?? m));
}
