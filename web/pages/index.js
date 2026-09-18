export default function Home() {
  return (
    <div style={{ fontFamily: "monospace", padding: 24 }}>
      <h2>SpacetimeDB Controller Test</h2>
      <h3>Maincloud</h3>
      <ul>
        <li><a href="/play?mode=cloud">Display</a> — open on your laptop</li>
        <li><a href="/controller?mode=cloud">Controller</a> — open anywhere</li>
      </ul>
      <h3>LAN</h3>
      <ul>
        <li><a href="/play?mode=lan">Display</a> — open on your laptop</li>
        <li><a href="/controller?mode=lan">Controller</a> — open on a phone on the same Wi-Fi</li>
      </ul>
    </div>
  );
}
