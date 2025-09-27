import { BrowserRouter as Router, Routes, Route } from 'react-router-dom'
import { FluentProvider, webLightTheme } from '@fluentui/react-components'
import Layout from './components/Layout'
import HomePage from './pages/HomePage'

function App() {
  return (
    <FluentProvider theme={webLightTheme}>
      <Router>
        <div style={{ height: '100%' }}>
          <Routes>
            <Route path="/" element={<Layout />}>
              <Route index element={<HomePage />} />
            </Route>
          </Routes>
        </div>
      </Router>
    </FluentProvider>
  )
}

export default App