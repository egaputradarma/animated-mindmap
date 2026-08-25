import { Navigate, Route, Routes } from 'react-router-dom'
import AnimatePage from './pages/AnimatePage'
import EditorPage from './pages/EditorPage'
import MindmapsPage from './pages/MindmapsPage'

export default function App() {
  return (
    <Routes>
      <Route path="/" element={<Navigate to="/mindmaps" replace />} />
      <Route path="/mindmaps" element={<MindmapsPage />} />
      <Route path="/mindmaps/:id" element={<EditorPage />} />
      {/* The "Generate Animated" button from the editor lands here. */}
      <Route path="/mindmaps/:id/animate" element={<AnimatePage />} />
      <Route path="*" element={<Navigate to="/mindmaps" replace />} />
    </Routes>
  )
}
