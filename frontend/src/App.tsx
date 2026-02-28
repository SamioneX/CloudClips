import { BrowserRouter, Routes, Route } from 'react-router-dom';

function Home() {
  return (
    <div style={{ maxWidth: 800, margin: '0 auto', padding: '2rem' }}>
      <h1>CloudClips</h1>
      <p>Short video sharing, powered by AWS.</p>
    </div>
  );
}

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<Home />} />
      </Routes>
    </BrowserRouter>
  );
}
