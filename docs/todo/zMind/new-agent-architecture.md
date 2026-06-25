Now, we are going to try to conceptualise an AI Agent architecture (potentially using LangGraph or Google ADK or Claude Agent SDK) but, the difference is, we are going to build the architecture mimicking these 3 systems in addition to the standard workflow. As in, we will have 3 specific documents representing these 3 systems, that guides the Agent similar to how the 3 system moderate human thoughts and behaviours. We call them RAS, DMN and AMG. So the Agent operates using the below .md files as the core guidelines (system Prompt parts):





Constitution.md - Primary system prompt / meta system prompt guiding the Agent who they are, how to behave, acceptable and unacceptable patterns, where to find and how to interpret other system prompt parts, etc.



RAS.md This is a dedicated part that guide the Agent on how to define and refine the information relevant for the given query / task at hand and how to look for the correct information pieces out of large context pools.



MEMORY.md - This contains past experiences of the Agent during it's interactions with the user, similar to the other Agent Memory systems which maintains recent memories and noteworthy points that the Agent should keep in mind regarding topics, activities, interests, challenges, goals. The learned memories should be appended, updated, consolidated and on a daily basis, summarised, with 30% weight to oldest memories gradually increasing to 70% weight for newest memories. (We can use an existing memory extraction system to populate memories into the document or we can build our own)



DMN.md - This document is a periodically updated interpretation of the Agent's perception of itself based on the Constitution.md and the MEMORY.md as well as it's interactions with the user. This one specifically guides the Agent to build a personalised (personalised to the Agent itself) narrative around the user query / task at hand. This narrative is done by the Agent, looking inwards, every time the Agent is thinking/ acting. 



AMG.md - is the built in safety guidance. This guide need to be a static document which defines guardrails for the safety of the Agent itself as well as the user. Should the Agent ignore portions of the query / task at hand for safety reasons? Should the Agent accept all the information received as true? Should the Agent execute things as it originally thought? Are those aligned with ethical, and security guidelines? Will they have a negative impact or degrade the outcome or the overall work product? Does the Agent have confirmation on accuracy and validity of the information, thoughts, and planned actions? This pushes the Agent to be sceptical and therefore more careful, organised, look at the big picture, understand implications and make educated judgements and decisions, respond instead of reacting and methodical.



HEARTBEAT.md - This document defines what independent actions and workflows that the Agent is suppose to execute when the heartbeat cron job is executed in the system. 



SOP.md - This document details and defines predefined workflows that the User want the Agent to follow.



SOW.md  - This document defines the daily routine and responsibilities of the Agent, much like a SOW of a regular employee



Documents 1-5 are equally high priority. 6-7 are secondary. 1-5 need to be sent along to the LLM at each LLM call (not added to the chat history to keep from duplication in the context window)



We also have a specific folder for the Agent to create its own learning files. This is a folder where the agent can create study notes for future references about things it learns and useful resources related to those topics.

