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

  it('renders empty state', () => {
    renderWithProvider(<HomePage />)
    expect(screen.getByText('No photos yet')).toBeInTheDocument()
    expect(screen.getByText('Upload your first photos to get started')).toBeInTheDocument()
  })

  it('renders photo details section', () => {
    renderWithProvider(<HomePage />)
    expect(screen.getByText('Photo Details')).toBeInTheDocument()
    expect(screen.getByText('Select a photo to view details')).toBeInTheDocument()
  })

  it('has upload buttons', () => {
    renderWithProvider(<HomePage />)
    const uploadButtons = screen.getAllByText('Upload Photos')
    expect(uploadButtons).toHaveLength(2) // One in toolbar, one in empty state
  })
})