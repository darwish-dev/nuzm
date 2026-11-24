import { Icon } from '@nuzm/ui';

/** Decorative conversational artwork, shared by AI service pages, cards, and navigation. */
export function AiChatArtwork() {
  return (
    <span className="ai-chat-art" aria-hidden="true" dir="ltr">
      <span className="ai-chat-scene">
        <span className="ai-chat-request">
          <span>
            <i />
            <i />
          </span>
          <b>
            <Icon name="user" size={16} />
          </b>
        </span>
        <span className="ai-chat-response">
          <b className="ai-chat-avatar">
            <Icon name="sparkle" size={20} />
          </b>
          <span>
            <strong>Nuzm AI</strong>
            <i />
            <i />
            <span className="ai-chat-typing">
              <i />
              <i />
              <i />
            </span>
          </span>
        </span>
        <span className="ai-chat-result">
          <span className="ai-chat-result-bar">
            <i />
            <i />
            <i />
            <Icon name="check" size={12} />
          </span>
          <span className="ai-chat-result-body">
            <span>
              <i />
              <i />
              <b />
            </span>
            <span className="ai-chat-result-tiles">
              <i />
              <i />
              <i />
            </span>
          </span>
        </span>
        <span className="ai-chat-send">
          <Icon name="arrow" size={17} />
        </span>
      </span>
    </span>
  );
}
