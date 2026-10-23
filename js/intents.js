// Turns what you said (or typed) into an action. Anything that isn't a command
// is treated as a question about the loaded text.
const clean = (s) => s.toLowerCase().replace(/[^a-z0-9' ]+/g, ' ').replace(/\s+/g, ' ').trim();

export function interpret(raw) {
  const t = clean(raw).replace(/^(hey |ok |okay |um |uh |so |please |earshot )+/, '').replace(/ please$/, '').trim();
  const is = (re) => re.test(t);
  if (!t) return { action: 'none' };
  if (is(/^(hi|hello|hey|yo|sup|what's up|whats up|good (morning|afternoon|evening))( there| earshot)?$/)) return { action: 'hello' };
  if (is(/^(thanks|thank you|thx|ty|cool thanks|awesome)( so much| earshot)?$/)) return { action: 'thanks' };
  if (is(/^(help|what can (you|i) (do|say)|commands|what are the commands)$/)) return { action: 'help' };
  if (is(/^(read|start|play|go|begin|continue|resume|keep (reading|going)|read (it|this|aloud|out loud|to me))( it| aloud| out loud| please)?$/)) return { action: 'read' };
  if (is(/^(read|continue|start|play) (from )?(there|that|that part|that passage|the answer|from there|from that)$/)) return { action: 'read', from: 'answer' };
  if (is(/^(start over|read from the (start|beginning|top)|go (back )?to the (start|beginning|top)|restart|from the (start|beginning|top))$/)) return { action: 'read', from: 'start' };
  if (is(/^(pause|wait|hold on|hold up|one sec(ond)?|hang on)$/)) return { action: 'pause' };
  if (is(/^(stop|stop reading|quiet|be quiet|shut up|shush|silence|enough)$/)) return { action: 'stop' };
  if (is(/^(faster|speed up|go faster|read faster|quicker|a bit faster|little faster|speed it up)$/)) return { action: 'faster' };
  if (is(/^(slower|slow down|go slower|read slower|a bit slower|little slower|slow it down)$/)) return { action: 'slower' };
  if (is(/^(next|skip|next sentence|skip (this|that|it|ahead)|forward)$/)) return { action: 'next', unit: 's' };
  if (is(/^(next paragraph|skip (this |the )?paragraph|next section|next part)$/)) return { action: 'next', unit: 'p' };
  if (is(/^(back|go back|previous|previous sentence|back one|last sentence)$/)) return { action: 'previous', unit: 's' };
  if (is(/^(previous paragraph|last paragraph|back a paragraph|go back a paragraph|previous section)$/)) return { action: 'previous', unit: 'p' };
  if (is(/^(repeat|again|say (that|it) again|what|what did (it|you) say|huh|pardon|sorry)$/)) return { action: 'repeat' };
  if (is(/^(where am i|where are we|how far (am i|are we)|what page|how much is left|progress)$/)) return { action: 'where' };
  if (is(/^(what is this|what's this|whats this)( about| text| document| article)?$|^(summarize|summarise|summary|sum it up|give me (a|the) summary|what is (it|this text|this document|this article) about|what's (it|this) about|tldr|tl dr)$/)) return { action: 'summary' };
  if (is(/^what time is it|^what's the time|^whats the time|^time$/)) return { action: 'time' };
  if (is(/^what('s| is) (the date|today('s date)?)$|^what day is (it|today)$/)) return { action: 'date' };
  const voice = t.match(/^(use|switch to|change (the )?voice to|voice) ([a-z]+)( voice)?$/);
  if (voice) return { action: 'voice', name: voice[3] };
  const find = t.match(/^(find|search( for)?|look for|read (me )?(the )?(part|passage|bit|section) (about|where|on|with)|where does it (say|talk about|mention)|go to (the )?(part|passage|bit|section) (about|where|on|with)|jump to) (.+)$/);
  if (find) return { action: 'question', query: find[find.length - 1] };
  return { action: 'question', query: raw.trim() };
}
