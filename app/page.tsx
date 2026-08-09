export default function Home() {
  return (
    <main className="preview-shell">
      <iframe
        className="preview-client"
        src="http://127.0.0.1:8080/client/index.html?api=http://127.0.0.1:8080"
        title="Babcord client"
      />
    </main>
  );
}
