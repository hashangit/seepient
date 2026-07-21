import { ToolModule, APPROVAL_SCHEMA } from '../../foundations/contracts/tool.js';
import { generateImages } from '../media/media.js';

const toolDefinition = {
  type: "function",
  function: {
    name: "generate_image",
    description: "Generates or edits images using AI models (DALL-E 3/2). Supports text-to-image, image variation, and image editing. Allows control over size, resolution (quality), and model selection.",
    parameters: {
      type: "object",
      properties: {
        prompt: {
          type: "string",
          description: "Text description of the desired image. Required for text-to-image and edit modes."
        },
        image_path: {
          type: "string",
          description: "Path to an existing image file (local path). Required for variation and editing modes."
        },
        mask_path: {
          type: "string",
          description: "Path to a mask image file (local path). Optional, used only for editing."
        },
        mode: {
          type: "string",
          enum: ["text-to-image", "variation", "edit"],
          description: "Operation mode. Inferred if not provided."
        },
        model: {
          type: "string",
          description: "The AI model to use. 'dall-e-3' for high quality (default), 'dall-e-2' for editing, or a custom model like 'doubao-seedream-4-5-251128'.",
          default: "dall-e-3"
        },
        n: {
          type: "integer",
          description: "Number of images to generate. Default is 1.",
          default: 1
        },
        size: {
          type: "string",
          description: "Resolution/Aspect Ratio. YOU should infer the best size based on the prompt content.\n- DALL-E 3: '1024x1024' (Square), '1792x1024' (Landscape), '1024x1792' (Portrait).\n- Doubao/High-Res: MUST be >3.6M pixels. Use '2048x2048' (Square), '2560x1440' (Landscape), '1440x2560' (Portrait).",
          default: "1024x1024"
        },
        quality: {
          type: "string",
          enum: ["standard", "hd"],
          description: "Image quality (DALL-E 3 only). 'hd' creates more detailed images. Default is 'standard'.",
          default: "standard"
        },
        style: {
          type: "string",
          enum: ["vivid", "natural"],
          description: "Image style (DALL-E 3 only). Default is 'vivid'.",
          default: "vivid"
        },
        output_dir: {
          type: "string",
          description: "Directory to save the generated images. Defaults to current directory."
        },
        approval: APPROVAL_SCHEMA
      },
      required: []
    }
  }
};

const handler = async (args: any, config: any): Promise<string> => {
  return generateImages(
    {
      prompt: args.prompt,
      imagePath: args.image_path,
      maskPath: args.mask_path,
      mode: args.mode,
      model: args.model,
      n: args.n,
      size: args.size,
      quality: args.quality,
      style: args.style,
      outputDir: args.output_dir,
    },
    config ?? {},
  );
};

export const ImageTool: ToolModule = {
  name: "Image Generation",
  risk: "edit",
  definition: toolDefinition as any,
  handler: handler
};
