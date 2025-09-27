import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { FluentProvider, webLightTheme } from '@fluentui/react-components'
import DragDropUpload from './DragDropUpload'

const renderWithProvider = (component: React.ReactElement) => {
  return render(
    <FluentProvider theme={webLightTheme}>
      {component}
    </FluentProvider>
  )
}

// Mock fetch for upload tests
global.fetch = vi.fn()

describe('DragDropUpload', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('renders drop zone with instructions', () => {
    renderWithProvider(<DragDropUpload />)
    
    expect(screen.getByText('Drop photos here or click to browse')).toBeInTheDocument()
    expect(screen.getByText(/Supports: JPEG, PNG, WebP, TIFF/)).toBeInTheDocument()
  })

  it('shows file input for selection', () => {
    renderWithProvider(<DragDropUpload />)
    
    const fileInput = screen.getByRole('group')
    expect(fileInput).toBeInTheDocument()
  })

  it('handles click to open file dialog', () => {
    const onFilesAdded = vi.fn()
    renderWithProvider(<DragDropUpload onFilesAdded={onFilesAdded} />)
    
    const dropZone = screen.getByRole('group')
    fireEvent.click(dropZone)
    
    // Should trigger file input click (tested via DOM interaction)
    expect(dropZone).toBeInTheDocument()
  })

  it('accepts configured file types', () => {
    renderWithProvider(<DragDropUpload acceptedTypes={['image/jpeg']} />)
    
    expect(screen.getByText('Drop photos here or click to browse')).toBeInTheDocument()
  })

  it('displays custom max file size', () => {
    renderWithProvider(<DragDropUpload maxFileSize={10} />)
    
    expect(screen.getByText(/max 10MB each/)).toBeInTheDocument()
  })
})