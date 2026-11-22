import { Icon } from '@nuzm/ui';

/**
 * The landing page's AI chat section: what chatting with Nuzm AI can do,, with an animation of the builder flow. The video (public/videos) is an ILLUSTRATIVE animation rendered from
 * design/ai-chat (not a capture of a live session), and its caption says so.
 */
export function AiChatSection() {
  return (
    <section id="chat" className="section wrap chat-section" aria-labelledby="chat-title">
      <div className="chat-copy">
        <span className="eyebrow">CHAT WITH NUZM AI</span>
        <h2 id="chat-title">
          Just say what you need.
          <br />
          <em>Nuzm AI builds it with you.</em>
        </h2>
        <p>
          From a first idea to a live website, one conversation. Nuzm AI plans it, builds a first
          version and applies your changes as you ask.
        </p>
        <div className="chat-actions">
          <a className="button button-blue" href="/en/builder/projects">
            Try Nuzm AI <Icon name="sparkle" size={16} />
          </a>
          <a className="button button-outline" href="/en">
            Open dashboard
          </a>
        </div>
      </div>
      <figure className="chat-video">
        <div className="chat-frame">
          <video
            controls
            playsInline
            preload="metadata"
            poster="/videos/nuzm-ai-chat.jpg"
            aria-label="An animation of chatting with Nuzm AI: describe a website, approve the plan, edit by chat, publish"
          >
            <source src="/videos/nuzm-ai-chat.mp4" type="video/mp4" />
          </video>
        </div>
        <figcaption>An illustrative animation of the Nuzm AI builder flow.</figcaption>
      </figure>
    </section>
  );
}
