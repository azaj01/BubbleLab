/**
 * PARSE DOCUMENT WORKFLOW
 *
 * A comprehensive workflow that converts images and PDFs into structured markdown
 * using AI vision analysis. Preserves document structure, describes charts and images
 * numerically, and maintains formatting and layout information.
 *
 * This workflow combines:
 * 1. PDF to images conversion using pdf-img-convert
 * 2. AI vision analysis for content extraction and markdown generation
 * 3. Structure preservation with table, chart, and image descriptions
 *
 * Returns clean markdown with preserved structure and detailed visual descriptions.
 */

import { z } from 'zod';
import { WorkflowBubble } from '../../types/workflow-bubble-class.js';
import type { BubbleContext } from '../../types/bubble.js';
import { CredentialType, type BubbleName } from '@bubblelab/shared-schemas';
import { PDFFormOperationsWorkflow } from './pdf-form-operations.workflow.js';
import { AIAgentBubble } from '../service-bubble/ai-agent.js';
import { AvailableModels } from '@bubblelab/shared-schemas';

/**
 * System prompt for document parsing and markdown conversion
 */
const DOCUMENT_PARSING_PROMPT = `Transcribe this page into clean, faithful markdown. Do NOT summarize, paraphrase, or drop content.

CORE RULES:
- Transcribe every visible text element verbatim — headings, titles, jurisdiction/city/state names, form names, labels, field values, footnotes, signatures, dates, page numbers.
- Preserve every identifier exactly as written (company names, account numbers, FEINs, addresses, phone numbers, emails, form IDs, docket numbers).
- Preserve every number exactly as written (do not round, reformat, or drop currency symbols or trailing zeros).
- Never collapse or merge items because they look similar to other pages. Each page is independent — its city, jurisdiction, form title, and totals must appear exactly as shown on THIS page.

STRUCTURE:
- Use markdown headings that mirror the document's own headings (e.g., "# GOLDEN SALES TAX RETURN" if that's the page title).
- Convert tables to markdown tables, preserving every row, column, and cell — including empty cells and 0.00 values.
- Use bullet or numbered lists to match lists in the source.
- Preserve section order top-to-bottom, left-to-right.

VISUAL ELEMENTS:
- Charts/graphs: describe type, axes, series, and transcribe every visible data point, label, legend entry, and axis tick.
- Images/diagrams: describe what is shown and transcribe any visible text.
- Checkboxes/radios: indicate checked vs unchecked and transcribe the label.
- Stamps, signatures, handwritten notes: transcribe text and note that it is a stamp/signature/handwriting.

BOILERPLATE:
- Include headers, footers, disclaimers, and legal text — they often identify the jurisdiction or form. Do not drop them.

DO NOT:
- Summarize the page's "purpose" in your own words.
- Add commentary, interpretation, or meta-text.
- Skip any field just because its value is blank or 0.00.
- Truncate long lists — include every item.

If the page is blank or unreadable, say so explicitly.`;
/**
 * Page analysis result interface
 */
interface PageAnalysis {
  pageNumber: number;
  markdown: string;
  hasCharts: boolean;
  hasTables: boolean;
  hasImages: boolean;
}

/**
 * Document metadata interface
 */
interface DocumentMetadata {
  totalPages: number;
  processedPages: number;
  hasVisualElements: boolean;
  processingTime: number;
  imageFormat: string;
  imageDpi: number;
}

/**
 * Parameters schema for Parse Document workflow
 */
const ParseDocumentWorkflowParamsSchema = z.object({
  documentData: z
    .string()
    .min(1, 'Document data is required')
    .describe(
      'Base64 encoded document data (PDF or image) OR R2 file URL starting with https://'
    ),
  documentType: z
    .enum(['pdf', 'image'])
    .default('pdf')
    .describe('Type of document being processed'),
  isFileUrl: z
    .boolean()
    .optional()
    .default(false)
    .describe(
      'Set to true if documentData is an R2 file URL instead of base64'
    ),
  conversionOptions: z
    .object({
      preserveStructure: z
        .boolean()
        .default(true)
        .describe('Maintain original document structure and hierarchy'),
      includeVisualDescriptions: z
        .boolean()
        .default(true)
        .describe(
          'Include detailed descriptions of charts, images, and diagrams'
        ),
      extractNumericalData: z
        .boolean()
        .default(true)
        .describe('Extract specific numerical values from charts and tables'),
      combinePages: z
        .boolean()
        .default(false)
        .describe(
          'Deprecated: Pages are always kept separate with clear headers'
        ),
    })
    .default({
      preserveStructure: true,
      includeVisualDescriptions: true,
      extractNumericalData: true,
      combinePages: false,
    })
    .describe('Options for document conversion and parsing'),
  imageOptions: z
    .object({
      format: z
        .enum(['png', 'jpeg'])
        .default('png')
        .describe('Output image format for PDF conversion'),
      quality: z
        .number()
        .min(0.1)
        .max(1.0)
        .default(0.9)
        .describe('Image quality (0.1-1.0, higher = better quality)'),
      dpi: z
        .number()
        .min(150)
        .max(300)
        .default(200)
        .describe('Output DPI for PDF conversion (higher = better quality)'),
      pages: z
        .array(z.number().positive())
        .optional()
        .describe('Specific page numbers to process (1-indexed)'),
    })
    .default({
      format: 'png',
      quality: 0.9,
      dpi: 200,
    })
    .describe('Options for PDF to images conversion'),
  aiOptions: z
    .object({
      model: AvailableModels.default(
        'google/gemini-3.1-flash-lite-preview'
      ).describe('AI model to use for document analysis and conversion'),
      temperature: z
        .number()
        .min(0)
        .max(2)
        .default(0.4)
        .describe(
          'Temperature for AI responses (balanced for accuracy vs recitation)'
        ),
      maxTokens: z
        .number()
        .positive()
        .default(2000)
        .describe('Maximum tokens for AI response'),
      jsonMode: z
        .boolean()
        .default(false)
        .describe('Use JSON mode for structured output'),
    })
    .default({
      model: 'google/gemini-3.1-flash-lite-preview',
      temperature: 0.4,
      maxTokens: 9000,
      jsonMode: false,
    })
    .describe('AI agent configuration options'),
  storageOptions: z
    .object({
      uploadImages: z
        .boolean()
        .default(false)
        .describe('Whether to upload converted page images to S3'),
      bucketName: z
        .string()
        .optional()
        .describe('S3 bucket name for image uploads'),
      pageImageUrls: z
        .array(
          z.object({
            pageNumber: z.number(),
            uploadUrl: z.string(),
            fileName: z.string(),
          })
        )
        .optional()
        .describe('Pre-generated upload URLs for page images'),
      userId: z
        .string()
        .optional()
        .describe('User ID for secure file isolation'),
    })
    .optional()
    .describe('Storage options for uploading page images'),
  credentials: z
    .record(z.nativeEnum(CredentialType), z.string())
    .optional()
    .describe(
      'Credentials for AI model access (GOOGLE_GEMINI_CRED, OPENAI_CRED, etc.)'
    ),
});

/**
 * Result schema for Parse Document workflow
 */
const ParseDocumentWorkflowResultSchema = z.object({
  markdown: z.string().describe('Generated markdown content from the document'),
  pages: z
    .array(
      z.object({
        pageNumber: z.number().describe('Page number (1-indexed)'),
        markdown: z.string().describe('Markdown content for this page'),
        hasCharts: z
          .boolean()
          .describe('Whether this page contains charts or graphs'),
        hasTables: z.boolean().describe('Whether this page contains tables'),
        hasImages: z.boolean().describe('Whether this page contains images'),
      })
    )
    .describe('Per-page analysis results'),
  metadata: z
    .object({
      totalPages: z.number().describe('Total number of pages processed'),
      processedPages: z
        .number()
        .describe('Number of pages successfully processed'),
      hasVisualElements: z
        .boolean()
        .describe('Whether document contains charts, tables, or images'),
      processingTime: z
        .number()
        .describe('Total processing time in milliseconds'),
      imageFormat: z.string().describe('Image format used for conversion'),
      imageDpi: z.number().describe('DPI used for image conversion'),
    })
    .describe('Metadata about the parsing process'),
  conversionSummary: z
    .object({
      totalCharacters: z
        .number()
        .describe('Total characters in generated markdown'),
      tablesExtracted: z
        .number()
        .describe('Number of tables converted to markdown'),
      chartsDescribed: z
        .number()
        .describe('Number of charts and graphs described'),
      imagesDescribed: z.number().describe('Number of images described'),
    })
    .describe('Summary of conversion results'),
  aiAnalysis: z
    .object({
      model: z.string().describe('AI model used for analysis'),
      iterations: z.number().describe('Number of AI iterations'),
      processingTime: z.number().describe('AI processing time in milliseconds'),
    })
    .describe('AI analysis metadata'),
  uploadedImages: z
    .array(
      z.object({
        pageNumber: z.number(),
        fileName: z.string(),
        fileUrl: z.string().optional(),
        uploaded: z.boolean(),
      })
    )
    .optional()
    .describe('Information about uploaded page images'),
  success: z.boolean().describe('Whether the workflow completed successfully'),
  error: z.string().describe('Error message if workflow failed'),
});

type ParseDocumentWorkflowParams = z.input<
  typeof ParseDocumentWorkflowParamsSchema
>;
type ParseDocumentWorkflowResult = z.output<
  typeof ParseDocumentWorkflowResultSchema
>;

/**
 * Parse Document Workflow
 * Converts PDFs and images to structured markdown using AI vision analysis
 */
export class ParseDocumentWorkflow extends WorkflowBubble<
  ParseDocumentWorkflowParams,
  ParseDocumentWorkflowResult
> {
  static readonly type = 'workflow' as const;
  static readonly bubbleName: BubbleName = 'parse-document-workflow';
  static readonly schema = ParseDocumentWorkflowParamsSchema;
  static readonly resultSchema = ParseDocumentWorkflowResultSchema;
  static readonly shortDescription =
    'Parse Document workflow: convert PDFs/images to markdown using AI vision';
  static readonly longDescription = `
    Comprehensive document parsing workflow that converts PDFs and images into structured markdown:
    
    **Process:**
    1. Convert PDFs to high-quality images (if needed)
    2. Analyze images using AI vision models to extract content
    3. Generate clean, structured markdown preserving document layout
    4. Describe charts, tables, and images with numerical data when possible
    
    **Features:**
    - **PDF & Image Support**: Handles both PDF documents and image files
    - **Structure Preservation**: Maintains headers, lists, paragraphs, and formatting
    - **Visual Element Analysis**: Describes charts, graphs, tables, and images in detail
    - **Numerical Data Extraction**: Extracts specific values from charts and tables
    - **High-Quality Conversion**: Configurable DPI and quality settings
    - **Per-Page Analysis**: Detailed breakdown of each page's content
    
    **Visual Element Handling:**
    - **Charts & Graphs**: Extract data points, trends, axis labels, percentages
    - **Tables**: Convert to markdown tables with all visible data
    - **Images & Diagrams**: Detailed descriptions including any visible text/numbers
    - **Forms**: Structure field names and any filled values
    
    **Output Options:**
    - Combined markdown document or per-page breakdown
    - Configurable structure preservation and visual descriptions
    - Comprehensive metadata and conversion statistics
    
    **Common Use Cases:**
    - **Document Digitization**: Convert scanned PDFs to editable markdown
    - **Report Analysis**: Extract data from business reports and charts
    - **Academic Papers**: Preserve structure and extract figures/tables
    - **Technical Documentation**: Maintain formatting and describe diagrams
    - **Research Materials**: Extract and structure information from various documents
    
    **Input**: PDF or image data + conversion preferences
    **Output**: Clean markdown with preserved structure and visual descriptions
  `;
  static readonly alias = 'parse-doc';

  constructor(params: ParseDocumentWorkflowParams, context?: BubbleContext) {
    super(params, context);
  }

  protected async performAction(
    context?: BubbleContext
  ): Promise<ParseDocumentWorkflowResult> {
    const startTime = Date.now();

    console.log(
      '[ParseDocumentWorkflow] Starting document parsing and conversion'
    );
    console.log(
      '[ParseDocumentWorkflow] Document type:',
      this.params.documentType
    );
    console.log(
      '[ParseDocumentWorkflow] Document data length:',
      this.params.documentData.length
    );

    try {
      // Step 0: Download file from R2 if needed
      let documentDataToProcess = this.params.documentData;
      if (
        this.params.isFileUrl ||
        this.params.documentData.startsWith('https://')
      ) {
        console.log(
          '[ParseDocumentWorkflow] Step 0: Downloading file from R2...'
        );

        try {
          const downloadResponse = await fetch(this.params.documentData);
          if (!downloadResponse.ok) {
            throw new Error(
              `Failed to download file: ${downloadResponse.status} ${downloadResponse.statusText}`
            );
          }

          const arrayBuffer = await downloadResponse.arrayBuffer();
          documentDataToProcess = Buffer.from(arrayBuffer).toString('base64');

          console.log(
            `[ParseDocumentWorkflow] Downloaded file successfully, size: ${arrayBuffer.byteLength} bytes`
          );
        } catch (downloadError) {
          throw new Error(
            `Failed to download file from R2: ${downloadError instanceof Error ? downloadError.message : 'Unknown error'}`
          );
        }
      }

      let imageData: Array<{
        pageNumber: number;
        imageData: string;
        format: string;
      }> = [];

      // Step 1: Convert to images (if needed)
      if (this.params.documentType === 'pdf') {
        console.log(
          '[ParseDocumentWorkflow] Step 1: Converting PDF to images...'
        );

        const imageWorkflow = new PDFFormOperationsWorkflow(
          {
            operation: 'convert-to-images',
            pdfData: documentDataToProcess,
            format: this.params.storageOptions?.uploadImages
              ? 'jpeg'
              : this.params.imageOptions?.format || 'png',
            quality: this.params.imageOptions?.quality || 0.9,
            dpi: this.params.imageOptions?.dpi || 200,
            pages: this.params.imageOptions?.pages,
            credentials: this.params.credentials,
          },
          context
        );

        const imageResult = await imageWorkflow.action();

        if (!imageResult.success || !imageResult.data?.images) {
          throw new Error(
            `PDF to images conversion failed: ${imageResult.error}`
          );
        }

        imageData = imageResult.data.images;
        console.log(
          `[ParseDocumentWorkflow] Converted ${imageData.length} pages to images`
        );
      } else {
        // For image input, create a single page entry
        imageData = [
          {
            pageNumber: 1,
            imageData: documentDataToProcess,
            format: this.params.imageOptions?.format || 'png',
          },
        ];
        console.log('[ParseDocumentWorkflow] Using provided image data');
      }

      // Step 1.5: Upload page images to S3 if enabled
      const uploadedImages: Array<{
        pageNumber: number;
        fileName: string;
        fileUrl?: string;
        uploaded: boolean;
      }> = [];

      console.log('[ParseDocumentWorkflow] DEBUG - Storage options:', {
        hasStorageOptions: !!this.params.storageOptions,
        uploadImages: this.params.storageOptions?.uploadImages,
        pageImageUrlsCount:
          this.params.storageOptions?.pageImageUrls?.length || 0,
        pageImageUrls: this.params.storageOptions?.pageImageUrls,
      });

      if (
        this.params.storageOptions?.uploadImages &&
        this.params.storageOptions?.pageImageUrls
      ) {
        console.log(
          '[ParseDocumentWorkflow] Step 1.5: Uploading page images to S3...'
        );

        for (const pageData of imageData) {
          const pageUploadInfo = this.params.storageOptions.pageImageUrls.find(
            (info) => info.pageNumber === pageData.pageNumber
          );

          if (pageUploadInfo) {
            console.log(
              `[ParseDocumentWorkflow] Uploading page ${pageData.pageNumber} to S3...`
            );
            try {
              // Convert base64 to buffer
              const imageBuffer = Buffer.from(
                pageData.imageData.replace(/^data:image\/[^;]+;base64,/, ''),
                'base64'
              );

              // Upload to S3 using the pre-signed URL
              const contentType =
                pageData.format === 'jpeg' ? 'image/jpeg' : 'image/png';
              const uploadResponse = await fetch(pageUploadInfo.uploadUrl, {
                method: 'PUT',
                body: imageBuffer,
                headers: {
                  'Content-Type': contentType,
                },
              });

              const uploaded = uploadResponse.ok;

              // Get the proper download URL using StorageBubble
              let finalImageUrl: string | undefined = undefined;
              if (uploaded) {
                try {
                  const { StorageBubble } = await import(
                    '../service-bubble/storage.js'
                  );
                  const downloadStorageBubble = new StorageBubble(
                    {
                      operation: 'getFile',
                      bucketName:
                        this.params.storageOptions.bucketName ||
                        'bubble-lab-bucket',
                      fileName: pageUploadInfo.fileName,
                      expirationMinutes: 1440, // 24 hours for page images
                      credentials: this.params.credentials,
                    },
                    this.context
                  );

                  const downloadResult = await downloadStorageBubble.action();
                  console.log(
                    `[ParseDocumentWorkflow] Download result for page ${pageData.pageNumber}:`,
                    {
                      success: downloadResult.success,
                      error: downloadResult.error,
                      hasDownloadUrl: !!downloadResult.data?.downloadUrl,
                      downloadUrl: downloadResult.data?.downloadUrl,
                    }
                  );

                  if (
                    downloadResult.success &&
                    downloadResult.data?.downloadUrl
                  ) {
                    finalImageUrl = downloadResult.data.downloadUrl;
                  }
                } catch (storageError) {
                  console.error(
                    `[ParseDocumentWorkflow] Failed to get download URL for page ${pageData.pageNumber}:`,
                    storageError
                  );
                }
              }

              uploadedImages.push({
                pageNumber: pageData.pageNumber,
                fileName: pageUploadInfo.fileName,
                fileUrl: finalImageUrl, // Ready-to-use download URL from StorageBubble
                uploaded,
              });

              console.log(
                `[ParseDocumentWorkflow] Page ${pageData.pageNumber} upload ${uploaded ? 'successful' : 'failed'}, finalImageUrl: ${finalImageUrl}`
              );
            } catch (error) {
              console.error(
                `[ParseDocumentWorkflow] Failed to upload page ${pageData.pageNumber}:`,
                error
              );
              uploadedImages.push({
                pageNumber: pageData.pageNumber,
                fileName: pageUploadInfo.fileName,
                uploaded: false,
              });
            }
          } else {
            console.log(
              `[ParseDocumentWorkflow] No upload URL found for page ${pageData.pageNumber}`
            );
          }
        }
      }

      // Step 2: Process pages with AI vision in parallel batches
      console.log(
        '[ParseDocumentWorkflow] Step 2: Analyzing pages with AI vision in parallel batches...'
      );

      const pageAnalyses: PageAnalysis[] = [];
      const totalAiProcessingTime = 0;
      let totalAiIterations = 0;

      console.log(
        `[ParseDocumentWorkflow] Processing ALL ${imageData.length} pages in parallel...`
      );
      console.log(
        `[ParseDocumentWorkflow] WARNING: Processing ${imageData.length} pages simultaneously may hit API rate limits for large documents`
      );

      // Create AI agents for ALL pages at once (no batching)
      const allPagePromises = imageData.map((page) => {
        console.log(
          `[ParseDocumentWorkflow] Starting page ${page.pageNumber}...`
        );

        const pagePrompt = DOCUMENT_PARSING_PROMPT;
        // Create AI agent for this page
        const aiAgent = new AIAgentBubble(
          {
            message: `Please extract all the data from the page.`,
            images: [
              {
                type: 'base64' as const,
                data: page.imageData,
                mimeType: page.format === 'png' ? 'image/png' : 'image/jpeg',
                description: `Document page ${page.pageNumber} for markdown conversion`,
              },
            ],
            systemPrompt: pagePrompt,
            model: {
              model:
                this.params.aiOptions?.model ||
                'google/gemini-3.1-flash-lite-preview',
              temperature: this.params.aiOptions?.temperature || 0.4,
              maxTokens: this.params.aiOptions?.maxTokens || 2000,
              jsonMode: this.params.aiOptions?.jsonMode ?? false,
            },
            credentials: this.params.credentials,
            tools: [],
            maxIterations: 6,
          },
          this.context
        );

        // Return the promise directly (don't await here - that's the key!)
        return aiAgent
          .action()
          .then((aiResult) => {
            if (!aiResult.success) {
              console.warn(
                `[ParseDocumentWorkflow] AI analysis failed for page ${page.pageNumber}: ${aiResult.error}`
              );
              return {
                pageNumber: page.pageNumber,
                markdown: `# Page ${page.pageNumber}\n\n*Error: Could not process this page*\n`,
                hasCharts: false,
                hasTables: false,
                hasImages: false,
                confidence: 0,
                iterations: 0,
              };
            }

            const markdown = aiResult.data?.response || '';

            // Analyze the generated markdown to detect visual elements
            const hasCharts = /chart|graph|figure|plot|axis|data|trend/i.test(
              markdown
            );
            const hasTables = /\|.*\|.*\|/m.test(markdown); // Basic markdown table detection
            const hasImages = /image|photo|picture|diagram|illustration/i.test(
              markdown
            );

            console.log(
              `[ParseDocumentWorkflow] Page ${page.pageNumber} processed: ${markdown.length} characters`
            );

            return {
              pageNumber: page.pageNumber,
              markdown,
              hasCharts,
              hasTables,
              hasImages,
              iterations: aiResult.data?.iterations || 0,
            };
          })
          .catch((error) => {
            console.error(
              `[ParseDocumentWorkflow] Error processing page ${page.pageNumber}:`,
              error
            );
            return {
              pageNumber: page.pageNumber,
              markdown: `# Page ${page.pageNumber}\n\n*Error: Could not process this page*\n`,
              hasCharts: false,
              hasTables: false,
              hasImages: false,
              confidence: 0,
              iterations: 0,
            };
          });
      });

      // Wait for ALL pages to complete in parallel
      console.log(
        `[ParseDocumentWorkflow] Waiting for all ${imageData.length} pages to complete...`
      );
      const allResults = await Promise.all(allPagePromises);

      // Add results to our main array and accumulate iterations
      for (const result of allResults) {
        totalAiIterations += result.iterations;
        pageAnalyses.push({
          pageNumber: result.pageNumber,
          markdown: result.markdown,
          hasCharts: result.hasCharts,
          hasTables: result.hasTables,
          hasImages: result.hasImages,
        });
      }

      console.log(
        `[ParseDocumentWorkflow] All ${allResults.length} pages completed in parallel!`
      );

      // Step 3: Format pages with proper separation (never combine pages)
      console.log(
        '[ParseDocumentWorkflow] Step 3: Formatting results with page separation...'
      );

      // Sort pages by page number to ensure correct order
      const sortedPages = pageAnalyses.sort(
        (a, b) => a.pageNumber - b.pageNumber
      );

      // Always separate pages with clear headers - never combine them
      const finalMarkdown = sortedPages
        .map((page) => `--- Page ${page.pageNumber} ---\n\n${page.markdown}`)
        .join('\n\n');

      // Step 4: Generate metadata and summary
      const processingTime = Date.now() - startTime;

      const conversionSummary = {
        totalCharacters: finalMarkdown.length,
        tablesExtracted: pageAnalyses.reduce(
          (sum, page) => sum + (page.hasTables ? 1 : 0),
          0
        ),
        chartsDescribed: pageAnalyses.reduce(
          (sum, page) => sum + (page.hasCharts ? 1 : 0),
          0
        ),
        imagesDescribed: pageAnalyses.reduce(
          (sum, page) => sum + (page.hasImages ? 1 : 0),
          0
        ),
      };

      const metadata: DocumentMetadata = {
        totalPages: imageData.length,
        processedPages: pageAnalyses.length,
        hasVisualElements: pageAnalyses.some(
          (page) => page.hasCharts || page.hasTables || page.hasImages
        ),
        processingTime,
        imageFormat: this.params.imageOptions?.format || 'png',
        imageDpi: this.params.imageOptions?.dpi || 200,
      };

      console.log(
        `[ParseDocumentWorkflow] Conversion completed successfully in ${processingTime}ms`
      );
      console.log(
        `[ParseDocumentWorkflow] Generated ${finalMarkdown.length} characters of markdown`
      );

      return {
        markdown: finalMarkdown,
        pages: pageAnalyses,
        metadata,
        conversionSummary,
        aiAnalysis: {
          model:
            this.params.aiOptions?.model ||
            'google/gemini-3.1-flash-lite-preview',
          iterations: totalAiIterations,
          processingTime: totalAiProcessingTime,
        },
        uploadedImages: uploadedImages.length > 0 ? uploadedImages : undefined,
        success: true,
        error: '',
      };
    } catch (error) {
      const processingTime = Date.now() - startTime;
      console.error('[ParseDocumentWorkflow] Workflow failed:', error);

      return {
        markdown: '',
        pages: [],
        metadata: {
          totalPages: 0,
          processedPages: 0,
          hasVisualElements: false,
          processingTime,
          imageFormat: this.params.imageOptions?.format || 'png',
          imageDpi: this.params.imageOptions?.dpi || 200,
        },
        conversionSummary: {
          totalCharacters: 0,
          tablesExtracted: 0,
          chartsDescribed: 0,
          imagesDescribed: 0,
        },
        aiAnalysis: {
          model:
            this.params.aiOptions?.model ||
            'google/gemini-3.1-flash-lite-preview',
          iterations: 0,
          processingTime,
        },
        success: false,
        error:
          error instanceof Error
            ? error.message
            : 'Unknown error during document parsing workflow',
      };
    }
  }
}
