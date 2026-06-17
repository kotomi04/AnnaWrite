import { ArrowDown, ArrowUp, Plus, RefreshCw, Sparkles, Trash2 } from "lucide-react";
import type { FocusEvent } from "react";
import { useState } from "react";
import type { Author, RequirementCard, WritingProject } from "../types";

interface RequirementsPageProps {
  project: WritingProject;
  currentAuthor: Author | null;
  onProjectChange: (patch: Partial<WritingProject>) => void;
  onRegenerateCard: (card: RequirementCard) => void;
  onReviseOutline: (instruction: string) => Promise<RequirementCard[] | null>;
  onReviseCard: (card: RequirementCard, instruction: string) => Promise<RequirementCard | null>;
  onGenerateDraft: () => void;
  onOpenDraft: () => void;
  onBackHome: () => void;
  hasDraft: boolean;
  busy: boolean;
}

export function RequirementsPage({
  project,
  currentAuthor,
  onProjectChange,
  onRegenerateCard,
  onReviseOutline,
  onReviseCard,
  onGenerateDraft,
  onOpenDraft,
  onBackHome,
  hasDraft,
  busy,
}: RequirementsPageProps) {
  const [outlineComment, setOutlineComment] = useState("");
  const [commentOpen, setCommentOpen] = useState(false);
  const [commentMode, setCommentMode] = useState<"whole" | "section" | null>(null);
  const [suggestedCards, setSuggestedCards] = useState<RequirementCard[] | null>(null);
  const [selectedCardId, setSelectedCardId] = useState<string | null>(null);
  const [suggestedCard, setSuggestedCard] = useState<RequirementCard | null>(null);
  const [commentHistory, setCommentHistory] = useState<string[]>([]);
  const sortedCards = [...project.requirementCards].sort((a, b) => a.order - b.order);
  const selectedCard = sortedCards.find((card) => card.id === selectedCardId) ?? null;

  const updateCards = (cards: RequirementCard[]) => {
    onProjectChange({ requirementCards: cards.map((card, order) => ({ ...card, order })) });
  };

  const updateCard = (cardId: string, patch: Partial<RequirementCard>) => {
    updateCards(sortedCards.map((card) => (card.id === cardId ? { ...card, ...patch } : card)));
  };

  const editableText = (event: FocusEvent<HTMLElement>) => event.currentTarget.innerText.trim();

  const moveCard = (index: number, direction: -1 | 1) => {
    const next = [...sortedCards];
    const target = index + direction;
    if (target < 0 || target >= next.length) return;
    [next[index], next[target]] = [next[target], next[index]];
    updateCards(next);
  };

  const deleteCard = (cardId: string) => {
    updateCards(sortedCards.filter((card) => card.id !== cardId));
    if (selectedCardId === cardId) {
      setSelectedCardId(null);
      setSuggestedCard(null);
    }
  };

  const addCard = () => {
    updateCards([
      ...sortedCards,
      {
        id: `card-${crypto.randomUUID()}`,
        type: "chapter",
        title: "New section",
        content: "Add the key point, evidence, scene, or chapter beat for this section.",
        authorLink: currentAuthor ? `Check against ${currentAuthor.name}'s operating manual.` : "Use the default writer.",
        priority: "medium",
        order: sortedCards.length,
        editable: true,
      },
    ]);
  };

  const sendWholeComment = async () => {
    const comment = outlineComment.trim();
    if (!comment) return;
    if (commentMode === "section" && selectedCard) {
      const nextCard = await onReviseCard(selectedCard, comment);
      if (nextCard) {
        setSuggestedCard(nextCard);
        setSuggestedCards(null);
        setCommentHistory((items) => [comment, ...items].slice(0, 4));
        setOutlineComment("");
      }
      return;
    }
    const revisedCards = await onReviseOutline(comment);
    if (revisedCards?.length) {
      setSuggestedCards(revisedCards);
      setSuggestedCard(null);
      setCommentHistory((items) => [comment, ...items].slice(0, 4));
      setOutlineComment("");
    }
  };

  const applySuggestion = () => {
    if (!suggestedCards?.length) return;
    updateCards(suggestedCards);
    setSuggestedCards(null);
  };

  const applyCardSuggestion = () => {
    if (!suggestedCard) return;
    updateCard(suggestedCard.id, suggestedCard);
    setSuggestedCard(null);
  };

  const selectCardForAi = (card: RequirementCard) => {
    setSelectedCardId(card.id);
    setSuggestedCard(null);
    setSuggestedCards(null);
    setOutlineComment("");
    setCommentMode("section");
    setCommentOpen(true);
    setCommentHistory([]);
  };

  const startWholeComment = () => {
    setSelectedCardId(null);
    setSuggestedCard(null);
    setSuggestedCards(null);
    setOutlineComment("");
    setCommentMode("whole");
    setCommentOpen(true);
    setCommentHistory([]);
  };

  const clearCommentTools = () => {
    setOutlineComment("");
    setCommentOpen(false);
    setCommentMode(null);
    setSelectedCardId(null);
    setSuggestedCard(null);
    setSuggestedCards(null);
    setCommentHistory([]);
  };

  return (
    <div className="page-scroll">
      <section className="outline-page mx-auto max-w-6xl">
        <div className="outline-topbar">
          <nav className="writing-progress" aria-label="Writing progress">
            <button className="progress-step done" type="button" onClick={onBackHome}>
              <span className="progress-dot" />
              <span>需求确认</span>
            </button>
            <button className="progress-step current" type="button">
              <span className="progress-dot" />
              <span>Outline</span>
            </button>
            <button className={`progress-step ${hasDraft ? "done" : ""}`} type="button" onClick={hasDraft ? onOpenDraft : undefined} disabled={!hasDraft}>
              <span className="progress-dot" />
              <span>正文</span>
            </button>
          </nav>
        </div>

        <div className="outline-header">
          <div>
            <div className="panel-kicker">目录确认</div>
            <h1
              className="editable-project-title"
              contentEditable
              suppressContentEditableWarning
              spellCheck={false}
              onBlur={(event) => {
                const title = editableText(event) || "确认写作目录";
                onProjectChange({ requirementTitle: title, title });
              }}
            >
              {project.requirementTitle || "确认写作目录"}
            </h1>
            <p>{project.brief || "No brief captured yet."}</p>
          </div>
          <div className="outline-top-actions">
            <button className="btn btn-secondary" onClick={onBackHome}>
              返回修改
            </button>
            <button className="btn btn-primary" onClick={onGenerateDraft} disabled={busy || sortedCards.length === 0}>
              <Sparkles size={14} />
              确认并开始
            </button>
          </div>
        </div>

        <div className="outline-workspace">
          <div className="outline-document" aria-label="Editable outline">
            {sortedCards.map((card, index) => (
              <article className={`outline-section${selectedCardId === card.id ? " selected" : ""}`} key={card.id}>
                <div className="outline-section-label">{String(index + 1).padStart(2, "0")}</div>
                <div className="outline-section-main">
                  <h2
                    className="outline-section-title-input"
                    contentEditable
                    suppressContentEditableWarning
                    spellCheck={false}
                    onBlur={(event) => updateCard(card.id, { title: editableText(event) || "Untitled section" })}
                    aria-label={`Outline section ${index + 1} title`}
                  >
                    {card.title}
                  </h2>
                  <p
                    className="outline-section-body-input"
                    contentEditable
                    suppressContentEditableWarning
                    spellCheck
                    onBlur={(event) => updateCard(card.id, { content: editableText(event) })}
                    aria-label={`Outline section ${index + 1} content`}
                  >
                    {card.content}
                  </p>
                  <p
                    className="outline-section-note-input"
                    contentEditable
                    suppressContentEditableWarning
                    spellCheck
                    data-placeholder="Author-style note"
                    onBlur={(event) => updateCard(card.id, { authorLink: editableText(event) })}
                    aria-label={`Outline section ${index + 1} author note`}
                  >
                    {card.authorLink}
                  </p>
                </div>
                <div className="outline-section-tools" aria-label={`Section ${index + 1} tools`}>
                  <button className="outline-edit-button" onClick={() => selectCardForAi(card)} aria-label="修改这一节">
                    <Sparkles size={14} />
                    <span>修改</span>
                  </button>
                  <button className="icon-button" onClick={() => moveCard(index, -1)} aria-label="Move section up"><ArrowUp size={14} /></button>
                  <button className="icon-button" onClick={() => moveCard(index, 1)} aria-label="Move section down"><ArrowDown size={14} /></button>
                  <button className="icon-button" onClick={() => onRegenerateCard(card)} aria-label="Regenerate section"><RefreshCw size={14} /></button>
                  <button className="icon-button text-rose-700" onClick={() => deleteCard(card.id)} aria-label="Delete section"><Trash2 size={14} /></button>
                </div>
              </article>
            ))}
            {sortedCards.length === 0 ? (
              <div className="outline-empty">
                <strong>No outline sections yet.</strong>
                <span>Add a section before creating the draft.</span>
              </div>
            ) : null}
          </div>

          <aside className="outline-ai-panel">
            <div className="profile-panel-head">
              <strong>AI 修改</strong>
              <button className="text-button" type="button" onClick={clearCommentTools}>清空</button>
            </div>
            <p className="ai-panel-hint">
              {commentOpen
                ? commentMode === "section"
                  ? "已选中目录中的一节。在 comment 里写下你想怎么改，然后点击发送。"
                  : "已选中全文目录。写下整体修改意见后，点击发送。"
                : "点击某一节右侧「修改」，或点击「全文 comment」，就可以在这里写 comment 和 AI 互动。"}
            </p>
            <button className="btn btn-secondary" type="button" onClick={addCard}>
              <Plus size={14} />
              Add section
            </button>
            {!commentOpen ? (
              <button className="btn btn-secondary" type="button" onClick={startWholeComment}>
                全文 comment
              </button>
            ) : null}
            {selectedCard ? (
              <div className="selected-outline-card">
                <span>正在修改</span>
                <strong>{selectedCard.title}</strong>
                <button
                  className="text-button"
                  type="button"
                  onClick={startWholeComment}
                >
                  改全文
                </button>
              </div>
            ) : null}
            <div className="selected-text">
              <strong>{currentAuthor ? currentAuthor.name : "Default writer"}</strong>
              <span>{currentAuthor ? currentAuthor.styleSummary : "No selected author; the draft will use a clean default voice."}</span>
            </div>
            {commentOpen ? (
              <div className="outline-comment-tools">
                <label className="field compact-field">
                  <span>Comment</span>
                  <textarea
                    className="field-input compact-textarea"
                    value={outlineComment}
                    onChange={(event) => setOutlineComment(event.target.value)}
                    placeholder={selectedCard ? `请修改「${selectedCard.title}」：例如，更具体一点；语气更像小红书；加一个转化引导。` : "例如：更具体一点；语气更像小红书；加一个转化引导。"}
                  />
                </label>
                <button className="btn btn-secondary" onClick={sendWholeComment} disabled={busy || !outlineComment.trim()}>
                  发送
                </button>
                {commentHistory.length ? (
                  <div className="comment-history" aria-label="Recent outline comments">
                    {commentHistory.map((comment, index) => (
                      <article className="readonly-comment" key={`${comment}-${index}`}>
                        <span>Comment</span>
                        <p>{comment}</p>
                      </article>
                    ))}
                  </div>
                ) : null}
                {suggestedCards?.length ? (
                  <div className="inline-ai-suggestion outline-suggestion" aria-label="AI outline suggestion">
                    <div className="profile-panel-head">
                      <strong>建议版本</strong>
                      <button className="text-button" type="button" onClick={() => setSuggestedCards(null)}>
                        取消
                      </button>
                    </div>
                    <div className="suggestion-outline-preview">
                      {suggestedCards.map((card, index) => (
                        <article className="outline-suggestion-card" key={`${card.id}-${index}`}>
                          <span>{String(index + 1).padStart(2, "0")}</span>
                          <div>
                            <strong>{card.title}</strong>
                            <p>{card.content}</p>
                          </div>
                        </article>
                      ))}
                    </div>
                    <button className="btn btn-primary" type="button" onClick={applySuggestion}>
                      应用到大纲
                    </button>
                  </div>
                ) : null}
                {suggestedCard ? (
                  <div className="inline-ai-suggestion outline-suggestion" aria-label="AI section suggestion">
                    <div className="profile-panel-head">
                      <strong>单节建议</strong>
                      <button className="text-button" type="button" onClick={() => setSuggestedCard(null)}>
                        取消
                      </button>
                    </div>
                    <article className="outline-suggestion-card single">
                      <span>{String((selectedCard?.order ?? suggestedCard.order) + 1).padStart(2, "0")}</span>
                      <div>
                        <strong>{suggestedCard.title}</strong>
                        <p>{suggestedCard.content}</p>
                        {suggestedCard.authorLink ? <small>{suggestedCard.authorLink}</small> : null}
                      </div>
                    </article>
                    <button className="btn btn-primary" type="button" onClick={applyCardSuggestion}>
                      应用到这一节
                    </button>
                  </div>
                ) : null}
              </div>
            ) : null}
          </aside>
        </div>
      </section>
    </div>
  );
}
