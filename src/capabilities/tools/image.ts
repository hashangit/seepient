import { ToolModule, APPROVAL_SCHEMA } from '../../foundations/contracts/tool.js';

const toolDefinition = {
  type: "function",
  function: {
    name: "generate_image",
    description: "Generates or edits images using configured image AI providers. Supports text-to-image, image variation, and image editing. Allows control over size, resolution/quality, aspect ratio, and output placement.",
    parameters: {
      type: "object",
      properties: {
        prompt: {
          type: "string",
          description: "Text description of the desired image. Required for text-to-image and edit modes."
        },
        output_path: {
          type: "string",
          description: "Exact destination path (e.g. 'images/output.png') to save the generated image. Policy demands exact-file commit capability for this path."
        },
        image_path: {
          type: "string",
          description: "Path to an existing input image file (local path). Required for variation and editing modes."
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
          description: "Optional model override for the configured image provider."
        },
        n: {
          type: "integer",
          description: "Number of images to generate. Default is 1.",
          default: 1
        },
        size: {
          type: "string",
          description: "Resolution/Aspect Ratio (e.g. '1024x1024' square, '1792x1024' landscape, '1024x1792' portrait).",
          default: "1024x1024"
        },
        quality: {
          type: "string",
          enum: ["standard", "hd"],
          description: "Image quality preset ('standard' or 'hd'). Default is 'standard'.",
          default: "standard"
        },
        style: {
          type: "string",
          enum: ["vivid", "natural"],
          description: "Image style preset ('vivid' or 'natural'). Default is 'vivid'.",
          default: "vivid"
        },
        output_dir: {
          type: "string",
          description: "Directory to save the generated images if output_path is not specified."
        },
        approval: APPROVAL_SCHEMA
      },
      required: []
    }
  }
};

export const ImageTool: ToolModule = {
  name: "Image Generation",
  risk: "edit",
  definition: toolDefinition as any,
};
