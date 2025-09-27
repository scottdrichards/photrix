import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { FluentProvider, webLightTheme } from '@fluentui/react-components'
import HomePage from './HomePage'

// Mock fetch globally
global.fetch = vi.fn()

const renderWithProvider = (component: React.ReactElement) => {
  return render(
    <FluentProvider theme={webLightTheme}>
      {component}
    </FluentProvider>
  )
}

describe('HomePage', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    // Mock successful empty photos response
    ;(global.fetch as any).mockResolvedValue({
      ok: true,
      json: async () => ({ photos: [], total: 0, message: 'No photos uploaded yet' })
    })
  })

  it('renders filters section by default', async () => {
    renderWithProvider(<HomePage />)
    await waitFor(() => {
      expect(screen.getByText('Filters')).toBeInTheDocument()
      expect(screen.getByLabelText('Date Range')).toBeInTheDocument()
      expect(screen.getByLabelText('Tags')).toBeInTheDocument()
    })
  })

  it('can hide filters section', async () => {
    renderWithProvider(<HomePage />)
    await waitFor(() => {
      expect(screen.getByText('Filters')).toBeInTheDocument()
    })
    
    const closeButton = screen.getByText('✕')
    fireEvent.click(closeButton)
    expect(screen.queryByText('Filters')).not.toBeInTheDocument()
    expect(screen.getByText('Show Filters')).toBeInTheDocument()
  })

  it('can show filters section after hiding', async () => {
    renderWithProvider(<HomePage />)
    await waitFor(() => {
      expect(screen.getByText('Filters')).toBeInTheDocument()
    })
    
    // Hide filters
    const closeButton = screen.getByText('✕')
    fireEvent.click(closeButton)
    // Show filters again
    const showButton = screen.getByText('Show Filters')
    fireEvent.click(showButton)
    expect(screen.getByText('Filters')).toBeInTheDocument()
  })

  it('renders photo count', async () => {
    renderWithProvider(<HomePage />)
    await waitFor(() => {
      expect(screen.getByText('0 photos')).toBeInTheDocument()
    })
  })

  it('renders empty state initially', async () => {
    renderWithProvider(<HomePage />)
    await waitFor(() => {
      expect(screen.getByText('No photos yet')).toBeInTheDocument()
      expect(screen.getByText('Upload your first photos to get started')).toBeInTheDocument()
    })
  })

  it('shows upload area when upload button is clicked', async () => {
    renderWithProvider(<HomePage />)
    
    await waitFor(() => {
      expect(screen.getByText('No photos yet')).toBeInTheDocument()
    })
    
    // Click the large upload button in empty state 
    const uploadButtons = screen.getAllByRole('button', { name: /Upload Photos/ })
    const largeUploadButton = uploadButtons.find(button => 
      button.textContent === 'Upload Photos' && button.closest('.___hxxk9s0_0000000, [class*="emptyState"]')
    ) || uploadButtons[uploadButtons.length - 1] // fallback to last button
    
    fireEvent.click(largeUploadButton!)
    
    // Should show upload area with specific content
    expect(screen.getByText('Drag and drop your photos or click to browse')).toBeInTheDocument()
    expect(screen.getByText('Drop photos here or click to browse')).toBeInTheDocument()
    expect(screen.getByText(/Supports: JPEG, PNG, WebP, TIFF/)).toBeInTheDocument()
  })

  it('can cancel upload area and return to empty state', async () => {
    renderWithProvider(<HomePage />)
    
    await waitFor(() => {
      expect(screen.getByText('No photos yet')).toBeInTheDocument()
    })
    
    // Click upload button to show upload area
    const uploadButtons = screen.getAllByRole('button', { name: /Upload Photos/ })
    const largeUploadButton = uploadButtons[uploadButtons.length - 1] // last upload button
    fireEvent.click(largeUploadButton)
    
    // Click cancel
    const cancelButton = screen.getByText('Cancel')
    fireEvent.click(cancelButton)
    
    // Should return to empty state
    expect(screen.getByText('No photos yet')).toBeInTheDocument()
    expect(screen.queryByText('Drop photos here or click to browse')).not.toBeInTheDocument()
  })

  it('renders photo details section', async () => {
    renderWithProvider(<HomePage />)
    await waitFor(() => {
      expect(screen.getByText('Photo Details')).toBeInTheDocument()
      expect(screen.getByText('No photos to display')).toBeInTheDocument()
    })
  })

  it('updates details section text when in upload mode', async () => {
    renderWithProvider(<HomePage />)
    
    await waitFor(() => {
      expect(screen.getByText('No photos yet')).toBeInTheDocument()
    })
    
    // Click upload button to show upload area
    const uploadButtons = screen.getAllByRole('button', { name: /Upload Photos/ })
    const largeUploadButton = uploadButtons[uploadButtons.length - 1] // last upload button
    fireEvent.click(largeUploadButton)
    
    // Details section should update
    expect(screen.getByText('Select files to upload')).toBeInTheDocument()
  })

  it('has view mode toggles', async () => {
    renderWithProvider(<HomePage />)
    
    await waitFor(() => {
      // Should have grid and list view toggles
      const gridButton = screen.getByLabelText('Grid view')
      const listButton = screen.getByLabelText('List view')
      
      expect(gridButton).toBeInTheDocument()
      expect(listButton).toBeInTheDocument()
    })
  })
})