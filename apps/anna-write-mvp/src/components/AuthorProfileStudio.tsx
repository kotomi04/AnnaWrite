import { Loader2, Sparkles, Square } from "lucide-react";
import type { AuthorProfileGenerationState } from "../types";

export function AuthorProfileStudio({
  profileText,
  generation,
  hasReadableMaterials,
  onBuildProfile,
  onCancelGeneration,
  onTextChange,
}: {
  profileText: string;
  generation: AuthorProfileGenerationState | null;
  hasReadableMaterials: boolean;
  onBuildProfile: () => void;
  onCancelGeneration: () => void;
  onTextChange: (value: string) => void;
}) {
  const generating = generation?.active ?? false;
  const hasProfile = Boolean(profileText.trim());

  return (
    <div className="author-profile-studio">
      <div className="author-profile-studio__head">
        <div>
          <span className="panel-kicker">Style profile</span>
          <p>Anna analyzes your samples here — stay on this page, edit the summary when done.</p>
        </div>
        <div className="author-profile-studio__actions">
          {generating ? (
            <button className="secondary-button compact" type="button" onClick={onCancelGeneration}>
              <Square size={14} />
              Stop
            </button>
          ) : null}
          <button
            className="primary-button compact"
            type="button"
            onClick={onBuildProfile}
            disabled={!hasReadableMaterials || generating}
          >
            {generating ? (
              <>
                <Loader2 className="animate-spin" size={14} />
                Analyzing…
              </>
            ) : (
              <>
                <Sparkles size={14} />
                {hasProfile ? "Rebuild profile" : "Build profile"}
              </>
            )}
          </button>
        </div>
      </div>

      {generating || generation?.log.length ? (
        <div className="author-profile-studio__stream" aria-live="polite">
          {generating ? (
            <div className="author-profile-studio__status">
              <Loader2 className="animate-spin" size={14} />
              <strong>{generation?.status ?? "Analyzing samples…"}</strong>
            </div>
          ) : null}
          {generation?.log.length ? (
            <ul className="author-profile-studio__log">
              {generation.log.map((line, index) => (
                <li key={`${line}-${index}`}>{line}</li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}

      {hasProfile || generating ? (
        <label className="field compact-field author-profile-studio__editor">
          <span>Style summary</span>
          <textarea
            className="description-textarea"
            value={profileText}
            onChange={(event) => onTextChange(event.target.value)}
            rows={9}
            disabled={generating}
            placeholder="Your author profile will appear here as Anna analyzes the samples."
          />
        </label>
      ) : (
        <div className="author-profile-studio__empty">
          <Sparkles size={16} />
          <p>{hasReadableMaterials ? "Build a profile from your samples." : "Add readable samples first."}</p>
        </div>
      )}
    </div>
  );
}
