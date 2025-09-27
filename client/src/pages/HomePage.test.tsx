import { describe, it, expect } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { FluentProvider, webLightTheme } from '@fluentui/react-components'
import HomePage from './HomePage'

const renderWithProvider = (component: React.ReactElement) => {
  return render(
    <FluentProvider theme={webLightTheme}>
      {component}
    </FluentProvider>
  )
}

describe('HomePage', () => {
  it('renders filters section by default', () => {
    renderWithProvider(<HomePage />)
    expect(screen.getByText('Filters')).toBeInTheDocument()
    expect(screen.getByLabelText('Date Range')).toBeInTheDocument()
    expect(screen.getByLabelText('Tags')).toBeInTheDocument()
  })

  it('can hide filters section', () => {
    renderWithProvider(<HomePage />)
    const closeButton = screen.getByText('✕')
    fireEvent.click(closeButton)
    expect(screen.queryByText('Filters')).not.toBeInTheDocument()
    expect(screen.getByText('Show Filters')).toBeInTheDocument()
  })

  it('can show filters section after hiding', () => {
    renderWithProvider(<HomePage />)
    // Hide filters
    const closeButton = screen.getByText('✕')
    fireEvent.click(closeButton)
    // Show filters again
    const showButton = screen.getByText('Show Filters')
    fireEvent.click(showButton)
    expect(screen.getByText('Filters')).toBeInTheDocument()
  })

  it('renders photo count', () => {
    renderWithProvider(<HomePage />)
    expect(screen.getByText('0 photos')).toBeInTheDocument()
  })

  it('renders empty state initially', () => {
    renderWithProvider(<HomePage />)
    expect(screen.getByText('No photos yet')).toBeInTheDocument()
    expect(screen.getByText('Upload your first photos to get started')).toBeInTheDocument()
  })

  it('shows upload area when upload button is clicked', () => {
    renderWithProvider(<HomePage />)
    
    // Click the large upload button in empty state 
    const uploadButtons = screen.getAllByRole('button', { name: /Upload Photos/ })
    const largeUploadButton = uploadButtons.find(button => 
      button.textContent === 'Upload Photos' && button.getAttribute('class')?.includes('large')
    ) || uploadButtons[1] // fallback to second button (large one in empty state)
    
    fireEvent.click(largeUploadButton!)
    
    // Should show upload area with specific content
    expect(screen.getByText('Drag and drop your photos or click to browse')).toBeInTheDocument()
    expect(screen.getByText('Drop photos here or click to browse')).toBeInTheDocument()
    expect(screen.getByText(/Supports: JPEG, PNG, WebP, TIFF/)).toBeInTheDocument()
  })

  it('can cancel upload area and return to empty state', () => {
    renderWithProvider(<HomePage />)
    
    // Click upload button to show upload area
    const uploadButtons = screen.getAllByRole('button', { name: /Upload Photos/ })
    const largeUploadButton = uploadButtons[1] // large button in empty state
    fireEvent.click(largeUploadButton)
    
    // Click cancel
    const cancelButton = screen.getByText('Cancel')
    fireEvent.click(cancelButton)
    
    // Should return to empty state
    expect(screen.getByText('No photos yet')).toBeInTheDocument()
    expect(screen.queryByText('Drop photos here or click to browse')).not.toBeInTheDocument()
  })

  it('renders photo details section', () => {
    renderWithProvider(<HomePage />)
    expect(screen.getByText('Photo Details')).toBeInTheDocument()
    expect(screen.getByText('Select a photo to view details')).toBeInTheDocument()
  })

  it('updates details section text when in upload mode', () => {
    renderWithProvider(<HomePage />)
    
    // Click upload button to show upload area
    const uploadButtons = screen.getAllByRole('button', { name: /Upload Photos/ })
    const largeUploadButton = uploadButtons[1] // large button in empty state
    fireEvent.click(largeUploadButton)
    
    // Details section should update
    expect(screen.getByText('Select files to upload')).toBeInTheDocument()
  })

  it('has view mode toggles', () => {
    renderWithProvider(<HomePage />)
    
    // Should have grid and list view toggles
    const gridButton = screen.getByLabelText('Grid view')
    const listButton = screen.getByLabelText('List view')
    
    expect(gridButton).toBeInTheDocument()
    expect(listButton).toBeInTheDocument()
  })
})