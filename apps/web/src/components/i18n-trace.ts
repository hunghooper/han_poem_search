/**
 * Trace sentences, in the three languages §17 puts in scope.
 *
 * Separate from `i18n.ts` because these are a different kind of label. The rest of that file
 * names buttons and columns; these are the system explaining its own reasoning, and they are
 * the text a reader most needs in their own language — a Vietnamese page that answers "why did
 * it decide that?" in English has failed at the only part that was hard.
 *
 * The codes come from `@han/shared/trace`, and `i18n.test.ts` checks this file against that
 * catalogue in all three languages. `{name}` is a value; `{parts}` is where composed
 * sub-messages land.
 *
 * FORM NAMES STAY IN HAN (五言絕句, 韻部, 平仄). They are the terms of the subject, they are
 * what the poems themselves use, and a reader looking at classical Chinese verse reads them
 * more easily than any translation of them — which is also what the request asked for: Chinese
 * is fine as long as it goes through i18n rather than being hardcoded.
 */

type Dict = Record<string, string>;

const vi: Dict = {
  'trace.readingQuery': 'Đang đọc câu bạn nhập',
  'trace.colophon': 'Đã tách phần lạc khoản: {lines}',
  'trace.colophonDated': 'Đã tách phần lạc khoản: {lines} ({date})',
  'trace.normalised': 'Chuẩn hoá còn {n} chữ',
  'trace.searching': 'Đang tra trong kho',

  'trace.src.skippedShort': 'Bỏ qua — khớp chính xác đã giải quyết xong',
  'trace.src.skipped': 'Bỏ qua',
  'trace.src.unavailable': 'Không dùng được — dịch vụ mô hình không chạy',
  'trace.src.timeout': 'Quá hạn',
  'trace.src.failed': 'Thất bại',
  'trace.src.none': '{parts} — không tìm thấy gì',
  'trace.src.count': '{parts} — {n} kết quả',
  'trace.src.noneRaw': '{source} — không tìm thấy gì',
  'trace.src.countRaw': '{source} — {n} kết quả',
  'trace.srcName.exact': 'Khớp chính xác',
  'trace.srcName.bm25': 'Tra theo từ khoá',
  'trace.srcName.vector': 'Tra theo ngữ nghĩa',
  'trace.srcName.reranker': 'Xếp hạng lại',

  'trace.conf.exactBelowFloor':
    'có một đoạn khớp chính xác, nhưng bài mà nó dẫn tới chỉ trùng {pct}% số chữ của câu bạn nhập — dưới mức sàn {floor}%, nên đoạn trùng đó là ngẫu nhiên chứ không phải bài thơ',
  'trace.conf.exactSingle': 'khớp chính xác liền mạch, dẫn về đúng một tác phẩm',
  'trace.conf.exactAmbiguous':
    'khớp chính xác nhưng dẫn tới {n} tác phẩm — đưa cả nhóm ứng viên ra, không đoán bừa một cái',
  'trace.conf.windowsAgree': '{n} cửa sổ đều chỉ về cùng một tác phẩm',
  'trace.conf.noCandidates': 'không nguồn tra nội bộ nào trả về ứng viên nào',
  'trace.conf.unscored': 'có {n} ứng viên nhưng chưa cái nào được chấm điểm — bộ xếp hạng lại không chạy',
  'trace.conf.overlapBelowFloor':
    'có ứng viên, nhưng cái tốt nhất chỉ trùng {pct}% số chữ của câu bạn nhập — dưới mức sàn {floor}%, nên điểm xếp hạng {score} không đáng tin',
  'trace.conf.belowNoiseFloor': 'điểm xếp hạng cao nhất {score} nằm dưới ngưỡng nhiễu {floor}',
  'trace.conf.scoredClears':
    'điểm xếp hạng cao nhất {score} vượt ngưỡng thẩm định nhưng không có đoạn khớp chính xác — cần kiểm chứng thêm',
  'trace.conf.scoredBetween':
    'điểm xếp hạng cao nhất {score} nằm giữa ngưỡng nhiễu và ngưỡng thẩm định',

  'trace.verify.failed': 'Kiểm tra thể thức không đạt — {parts}',
  'trace.verify.passed': 'Thể thức khớp — {parts}',
  'trace.verify.abstained':
    'Không đủ cấu trúc để kiểm — không xác nhận mà cũng không bác bỏ ứng viên này',
  'trace.verify.formReordered':
    '{form} — câu nhập đã bị đảo thứ tự, nên hình dạng dòng của nó không nói lên điều gì về bài thơ',
  'trace.verify.formMatches': '{form} — {n} chữ mỗi dòng, khớp với câu bạn nhập',
  'trace.verify.formDiffers': '{form} có {n} chữ mỗi dòng, còn câu bạn nhập có {input}',
  'trace.verify.notRegulated': '{form} không phải cận thể — luật vần và luật bằng trắc không áp dụng',
  'trace.verify.shapeGuess':
    '{parts} — nhưng bài có hình dạng này có thể là 古詩 chứ không phải {form}, nên điều đó không kết luận được gì',
  'trace.verify.toneBroken': '{parts} — điều đó khiến bài này là 古體, chứ không phải một bài khác',
  'trace.rhyme.tooFew': 'ít hơn hai vị trí gieo vần — không có gì để so',
  'trace.rhyme.notInTable': 'chữ gieo vần không có trong bảng vần suy ra từ kho — không phán được',
  'trace.rhyme.share': 'các chữ vần {chars} cùng một 韻部 suy ra từ kho',
  'trace.rhyme.differ': 'các chữ vần {chars} rơi vào những 韻部 khác nhau',
  'trace.tone.tooFew': 'quá ít chữ có trong bảng thanh điệu suy ra từ kho để phán',
  'trace.tone.clean': 'luật 平仄 giữ đúng ở 二四六 ({n} ngoại lệ, phủ {coverage}%)',
  'trace.tone.broken': 'luật 平仄 gãy ở {n} vị trí (phủ {coverage}%)',
  'trace.nothingToVerify': 'Không có gì để kiểm — không có ứng viên',

  'trace.agent.off': 'Agent đang tắt trong cài đặt',
  'trace.agent.noGateway': 'Chưa cấu hình cổng LLM — agent không chạy được',
  'trace.agent.tookOver': 'Agent tiếp quản',
  'trace.agent.noRelay':
    'Agent đang chạy — không xem được diễn tiến trực tiếp (thiếu Redis), nhưng kết quả vẫn sẽ về',
  'trace.agent.skippedNoOverlap':
    'Bỏ qua agent — câu bạn nhập không chung một chữ nào với bất cứ gì trong kho, nên ở đây không có gì để suy luận',
  'trace.agent.failed': 'Agent hỏng — trả lời bằng những gì đã thu được',
  'trace.agent.found': 'Agent tìm được {n} kết quả',
  'trace.agent.stopped': 'Agent dừng — {reason}',
  'trace.agent.chose': 'Chọn công cụ {tool}',
  'trace.agent.finishing': 'Quyết định dừng lại',
  'trace.tool.count': '{tool} — {n} kết quả',
  'trace.tool.none': '{tool} — đã tra, không thấy gì',
  'trace.tool.lowConfidence': '{tool} — có ứng viên, nhưng không cái nào đủ liên quan',
  'trace.tool.timeout': '{tool} — quá hạn (CHƯA tra được)',
  'trace.tool.unavailable': '{tool} — không dùng được (CHƯA tra được)',
  'trace.tool.failed': '{tool} — hỏng: {error}',
  'trace.tool.other': '{tool} — {status}',

  'trace.judge.checking': 'Đang kiểm xem chứng cứ có thật sự đủ kết luận không',
  'trace.judge.unreachable': 'Không gọi được con thẩm định — chứng cứ chưa qua kiểm',
  'trace.judge.sufficient': 'đủ kết luận — {notes}',
  'trace.judge.insufficient': 'chưa đủ kết luận — {notes}',
  'trace.judge.conflicting': 'các nguồn mâu thuẫn — {notes}',
  'trace.judge.proposed': 'Đã đề xuất “{title}” cho kho — chờ người duyệt',
  'trace.judge.declined': 'Không đề xuất — {parts}',
  'trace.propose.notSufficient': 'con thẩm định không cho là chứng cứ đã đủ',
  'trace.propose.localAnswered': 'kho nội bộ đã trả lời được rồi',
  'trace.propose.urlNotRetrieved': 'nguồn được nêu không phải URL mà lượt chạy này thật sự lấy về',
  'trace.propose.failsRules':
    'đề xuất không qua nổi chính những luật một người phải qua: {fields}',
  'trace.propose.duplicate': 'đã có trong kho',

  'trace.answer.none': 'Không có câu trả lời đủ chắc{parts}',
  'trace.answer.nothingMatches': 'Không có câu trả lời đủ chắc — không gì trong kho khớp cả{parts}',
  'trace.answer.local': '{title} — {author}{parts}',
  'trace.answer.outside': '{title} — qua {source}{parts}',
  'trace.answer.partialSuffix': ' (chưa trọn — agent hết ngân sách)',
};

const en: Dict = {
  'trace.readingQuery': 'Reading your query',
  'trace.colophon': 'Set aside an inscription: {lines}',
  'trace.colophonDated': 'Set aside an inscription: {lines} ({date})',
  'trace.normalised': 'Normalised to {n} characters',
  'trace.searching': 'Searching the corpus',

  'trace.src.skippedShort': 'Skipped — the exact match already resolved it',
  'trace.src.skipped': 'Skipped',
  'trace.src.unavailable': 'Not available — the model service is not running',
  'trace.src.timeout': 'Timed out',
  'trace.src.failed': 'Failed',
  'trace.src.none': '{parts} — nothing found',
  'trace.src.count': '{parts} — {n} results',
  'trace.src.noneRaw': '{source} — nothing found',
  'trace.src.countRaw': '{source} — {n} results',
  'trace.srcName.exact': 'Exact match',
  'trace.srcName.bm25': 'Keyword search',
  'trace.srcName.vector': 'Semantic search',
  'trace.srcName.reranker': 'Re-ranked candidates',

  'trace.conf.exactBelowFloor':
    "an exact run matched, but the work it resolves to shares only {pct}% of the query's characters — below the {floor}% floor, so the run is a coincidence rather than the poem",
  'trace.conf.exactSingle': 'exact contiguous match resolving to a single work',
  'trace.conf.exactAmbiguous':
    'exact match resolving to {n} works — candidates passed forward, not guessed between',
  'trace.conf.windowsAgree': '{n} windows agree on the same work',
  'trace.conf.noCandidates': 'no candidates returned by any local retriever',
  'trace.conf.unscored': '{n} candidates exist but none has been scored — reranker not available',
  'trace.conf.overlapBelowFloor':
    "candidates exist but the best shares only {pct}% of the query's characters — below the {floor}% floor, so the rerank score of {score} is not believed",
  'trace.conf.belowNoiseFloor': 'top rerank score {score} is below the noise floor {floor}',
  'trace.conf.scoredClears':
    'top rerank score {score} clears the verify floor but no exact match — requires verification',
  'trace.conf.scoredBetween': 'top rerank score {score} sits between the noise and verify floors',

  'trace.verify.failed': 'Form check failed — {parts}',
  'trace.verify.passed': 'Form checks out — {parts}',
  'trace.verify.abstained':
    'Not enough structure to verify — the candidate was neither confirmed nor rejected',
  'trace.verify.formReordered':
    "{form} — the input was reordered, so its line shape says nothing about the poem's",
  'trace.verify.formMatches': '{form} — {n} characters per line, matching the input',
  'trace.verify.formDiffers': '{form} has {n} characters per line but the input has {input}',
  'trace.verify.notRegulated': '{form} is not regulated verse — rhyme and tone rules do not apply',
  'trace.verify.shapeGuess':
    '{parts} — but a poem of this shape may be 古詩 rather than {form}, so this decides nothing',
  'trace.verify.toneBroken': '{parts} — which makes this 古體, not a different poem',
  'trace.rhyme.tooFew': 'fewer than two rhyme positions — nothing to compare',
  'trace.rhyme.notInTable': 'rhyme characters are not in the derived table — cannot judge',
  'trace.rhyme.share': 'rhyme characters {chars} share a derived 韻部',
  'trace.rhyme.differ': 'rhyme characters {chars} fall in different derived 韻部',
  'trace.tone.tooFew': 'too few characters found in the derived tone table to judge',
  'trace.tone.clean': '平仄 alternation holds at 二四六 ({n} exception, {coverage}% coverage)',
  'trace.tone.broken': '平仄 alternation broken at {n} positions ({coverage}% coverage)',
  'trace.nothingToVerify': 'Nothing to verify — no candidate',

  'trace.agent.off': 'Agent is switched off in settings',
  'trace.agent.noGateway': 'No LLM gateway is configured — the agent could not run',
  'trace.agent.tookOver': 'Agent took over',
  'trace.agent.noRelay':
    'Agent running — live trace unavailable (no Redis), the answer will still arrive',
  'trace.agent.skippedNoOverlap':
    'Agent skipped — the query shares no characters with anything in the corpus, so there is nothing here to reason about',
  'trace.agent.failed': 'The agent failed — answering from the evidence collected so far',
  'trace.agent.found': 'Agent found {n} results',
  'trace.agent.stopped': 'Agent stopped — {reason}',
  'trace.agent.chose': 'Chose {tool}',
  'trace.agent.finishing': 'Decided to finish',
  'trace.tool.count': '{tool} — {n} results',
  'trace.tool.none': '{tool} — searched, found nothing',
  'trace.tool.lowConfidence': '{tool} — candidates found, none relevant enough',
  'trace.tool.timeout': '{tool} — timed out (did NOT search)',
  'trace.tool.unavailable': '{tool} — unavailable (did NOT search)',
  'trace.tool.failed': '{tool} — failed: {error}',
  'trace.tool.other': '{tool} — {status}',

  'trace.judge.checking': 'Checking whether the evidence actually settles it',
  'trace.judge.unreachable': 'The verifier could not be reached — the evidence is unchecked',
  'trace.judge.sufficient': 'sufficient — {notes}',
  'trace.judge.insufficient': 'insufficient — {notes}',
  'trace.judge.conflicting': 'conflicting — {notes}',
  'trace.judge.proposed': 'Proposed “{title}” for the corpus — awaiting review',
  'trace.judge.declined': 'Proposal declined — {parts}',
  'trace.propose.notSufficient': 'the verifier did not call the evidence sufficient',
  'trace.propose.localAnswered': 'the local corpus already answered',
  'trace.propose.urlNotRetrieved': 'the proposed source is not a URL this run retrieved',
  'trace.propose.failsRules': 'the proposal fails the same rules a person must pass: {fields}',
  'trace.propose.duplicate': 'already in the corpus',

  'trace.answer.none': 'No confident answer{parts}',
  'trace.answer.nothingMatches': 'No confident answer — nothing in the corpus matches{parts}',
  'trace.answer.local': '{title} — {author}{parts}',
  'trace.answer.outside': '{title} — via {source}{parts}',
  'trace.answer.partialSuffix': ' (partial — the agent ran out of budget)',
};

const zh: Dict = {
  'trace.readingQuery': '正在讀取你輸入的內容',
  'trace.colophon': '已析出落款：{lines}',
  'trace.colophonDated': '已析出落款：{lines}（{date}）',
  'trace.normalised': '正規化後為 {n} 字',
  'trace.searching': '正在檢索詩庫',

  'trace.src.skippedShort': '略過——精確匹配已得結果',
  'trace.src.skipped': '略過',
  'trace.src.unavailable': '無法使用——模型服務未運行',
  'trace.src.timeout': '逾時',
  'trace.src.failed': '失敗',
  'trace.src.none': '{parts}——未找到',
  'trace.src.count': '{parts}——{n} 條結果',
  'trace.src.noneRaw': '{source}——未找到',
  'trace.src.countRaw': '{source}——{n} 條結果',
  'trace.srcName.exact': '精確匹配',
  'trace.srcName.bm25': '關鍵詞檢索',
  'trace.srcName.vector': '語義檢索',
  'trace.srcName.reranker': '重新排序',

  'trace.conf.exactBelowFloor':
    '有一段精確匹配，但其指向的作品僅與輸入共用 {pct}% 的字——低於 {floor}% 的下限，故此段相合出於偶然，並非該詩',
  'trace.conf.exactSingle': '精確連續匹配，指向唯一一篇作品',
  'trace.conf.exactAmbiguous': '精確匹配指向 {n} 篇作品——候選一併呈上，不在其間妄斷',
  'trace.conf.windowsAgree': '{n} 個窗口一致指向同一作品',
  'trace.conf.noCandidates': '本地各檢索途徑均未返回候選',
  'trace.conf.unscored': '有 {n} 個候選，但均未評分——重排序器不可用',
  'trace.conf.overlapBelowFloor':
    '雖有候選，但最佳者僅與輸入共用 {pct}% 的字——低於 {floor}% 的下限，故 {score} 的重排分數不足採信',
  'trace.conf.belowNoiseFloor': '最高重排分數 {score} 低於噪聲下限 {floor}',
  'trace.conf.scoredClears': '最高重排分數 {score} 已過核驗門檻，但無精確匹配——尚須查證',
  'trace.conf.scoredBetween': '最高重排分數 {score} 介於噪聲下限與核驗門檻之間',

  'trace.verify.failed': '格律核驗未過——{parts}',
  'trace.verify.passed': '格律相合——{parts}',
  'trace.verify.abstained': '結構不足以核驗——既未確認，亦未否定該候選',
  'trace.verify.formReordered': '{form}——輸入已被打亂次序，其句式說明不了該詩的句式',
  'trace.verify.formMatches': '{form}——每句 {n} 字，與輸入相合',
  'trace.verify.formDiffers': '{form} 每句 {n} 字，而輸入每句 {input} 字',
  'trace.verify.notRegulated': '{form} 非近體——韻律與平仄之規不適用',
  'trace.verify.shapeGuess': '{parts}——但此等句式之作或為古詩而非{form}，故此不足為斷',
  'trace.verify.toneBroken': '{parts}——此則為古體，非另一首詩',
  'trace.rhyme.tooFew': '韻腳不足兩處——無從比對',
  'trace.rhyme.notInTable': '韻腳不在推得的韻表之中——無從判定',
  'trace.rhyme.share': '韻腳 {chars} 同屬一個推得的韻部',
  'trace.rhyme.differ': '韻腳 {chars} 分屬不同的推得韻部',
  'trace.tone.tooFew': '見於推得平仄表中的字太少，無從判定',
  'trace.tone.clean': '平仄於二四六處合律（{n} 處拗，覆蓋 {coverage}%）',
  'trace.tone.broken': '平仄於 {n} 處失律（覆蓋 {coverage}%）',
  'trace.nothingToVerify': '無可核驗——並無候選',

  'trace.agent.off': '設定中已關閉 agent',
  'trace.agent.noGateway': '未配置 LLM 網關——agent 無法運行',
  'trace.agent.tookOver': 'agent 接手',
  'trace.agent.noRelay': 'agent 運行中——無法實時查看過程（缺少 Redis），但結果仍會送達',
  'trace.agent.skippedNoOverlap': '略過 agent——輸入與詩庫中任何內容無一字相同，此處無可推求',
  'trace.agent.failed': 'agent 出錯——以已得證據作答',
  'trace.agent.found': 'agent 找到 {n} 條結果',
  'trace.agent.stopped': 'agent 停止——{reason}',
  'trace.agent.chose': '選用 {tool}',
  'trace.agent.finishing': '決定收束',
  'trace.tool.count': '{tool}——{n} 條結果',
  'trace.tool.none': '{tool}——已檢索，未找到',
  'trace.tool.lowConfidence': '{tool}——有候選，但均不夠相關',
  'trace.tool.timeout': '{tool}——逾時（並未檢索）',
  'trace.tool.unavailable': '{tool}——無法使用（並未檢索）',
  'trace.tool.failed': '{tool}——失敗：{error}',
  'trace.tool.other': '{tool}——{status}',

  'trace.judge.checking': '正在核驗證據是否真能定案',
  'trace.judge.unreachable': '無法連上核驗模型——證據未經核驗',
  'trace.judge.sufficient': '證據充分——{notes}',
  'trace.judge.insufficient': '證據不足——{notes}',
  'trace.judge.conflicting': '諸源相牴——{notes}',
  'trace.judge.proposed': '已提議將「{title}」收入詩庫——待人審核',
  'trace.judge.declined': '未予提議——{parts}',
  'trace.propose.notSufficient': '核驗模型並未認定證據充分',
  'trace.propose.localAnswered': '本地詩庫已能作答',
  'trace.propose.urlNotRetrieved': '所稱來源並非本次運行真正取得的網址',
  'trace.propose.failsRules': '該提議過不了與常人相同的那套規則：{fields}',
  'trace.propose.duplicate': '詩庫中已有',

  'trace.answer.none': '無可確信的答案{parts}',
  'trace.answer.nothingMatches': '無可確信的答案——詩庫中無一相合{parts}',
  'trace.answer.local': '{title} — {author}{parts}',
  'trace.answer.outside': '{title} — 經 {source}{parts}',
  'trace.answer.partialSuffix': '（未竟——agent 預算用盡）',
};

export const TRACE_LABELS: Record<'vi' | 'en' | 'zh', Dict> = { vi, en, zh };
