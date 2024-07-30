import slugify from "@calcom/lib/slugify";
import prisma from "@calcom/prisma";

import { TRPCError } from "@trpc/server";

import type { TrpcSessionUser } from "../../../trpc";
import type { ZAssignUserToAttribute } from "./assignUserToAttribute.schema";

type GetOptions = {
  ctx: {
    user: NonNullable<TrpcSessionUser>;
  };
  input: ZAssignUserToAttribute;
};

function isOrgAdminOrThrow(ctx: GetOptions["ctx"]) {
  const org = ctx.user.organization;
  if (!org.isOrgAdmin) {
    throw new TRPCError({
      code: "UNAUTHORIZED",
      message: "You need to be an admin of the organization to use this feature",
    });
  }
}

const assignUserToAttributeHandler = async ({ input, ctx }: GetOptions) => {
  const org = ctx.user.organization;

  if (!org.id) {
    throw new TRPCError({
      code: "UNAUTHORIZED",
      message: "You need to be apart of an organization to use this feature",
    });
  }

  isOrgAdminOrThrow(ctx);

  // TODO: We need to also empty the users assignemnts for IDs that are not in in this filteredAttributes list
  // Filter out attributes that don't have a value or options set
  const filteredAttributes = input.attributes.filter((attribute) => attribute.value || attribute.options);

  // Ensure this organization can access these attributes and attribute options
  const attributes = await prisma.attribute.findMany({
    where: {
      id: {
        in: filteredAttributes.map((attribute) => attribute.id),
      },
      teamId: org.id,
    },
    select: {
      id: true,
      type: true,
      options: true,
    },
  });

  if (attributes.length !== filteredAttributes.length) {
    throw new TRPCError({
      code: "UNAUTHORIZED",
      message: "You do not have access to these attributes",
    });
  }

  const arrayOfAttributeOptionIds = attributes.flatMap(
    (attribute) => attribute.options?.map((option) => option.id) || []
  );

  const attributeOptionIds = Array.from(new Set(arrayOfAttributeOptionIds));

  const attributeOptions = await prisma.attributeOption.findMany({
    where: {
      id: {
        in: attributeOptionIds,
      },
      attribute: {
        teamId: org.id,
      },
    },
    select: {
      id: true,
      value: true,
      slug: true,
    },
  });

  if (attributeOptions.length !== attributeOptionIds.length) {
    throw new TRPCError({
      code: "UNAUTHORIZED",
      message: "You do not have access to these attribute options",
    });
  }

  const membership = await prisma.membership.findFirst({
    where: {
      userId: input.userId,
      teamId: org.id,
    },
  });

  if (!membership) {
    throw new TRPCError({
      code: "UNAUTHORIZED",
      message: "This user is not apart of your organization",
    });
  }

  // const promises: Promise<{ id: string }>[] = [];

  filteredAttributes.map(async (attribute) => {
    console.log(attribute);
    // TEXT, NUMBER
    if (attribute.value && !attribute.options) {
      const valueAsString = String(attribute.value);

      // Check if if it is already the value
      const existingAttributeOption = await prisma.attributeToUser.findFirst({
        where: {
          memberId: membership.id,
          attributeOption: {
            attribute: {
              id: attribute.id,
            },
          },
        },
        select: {
          id: true,
          attributeOption: {
            select: {
              id: true,
            },
          },
        },
      });

      if (existingAttributeOption) {
        // Update the value if it already exists
        await prisma.attributeOption.update({
          where: {
            id: existingAttributeOption.attributeOption.id,
          },
          data: {
            value: valueAsString,
            slug: slugify(valueAsString),
          },
        });
        return;
      }

      await prisma.attributeOption.create({
        data: {
          value: valueAsString,
          slug: slugify(valueAsString),
          attribute: {
            connect: {
              id: attribute.id,
            },
          },
          assignedUsers: {
            create: {
              memberId: membership.id,
            },
          },
        },
        select: {
          id: true,
        },
      });
    } else if (!attribute.value && attribute.options && attribute.options.length > 0) {
      // Get tha attribute type for this attribute
      const attributeType = attributes.find((attr) => attr.id === attribute.id)?.type;
      const options = attribute.options;

      if (attributeType === "SINGLE_SELECT") {
        prisma.attributeToUser.deleteMany({
          where: {
            attributeOption: {
              attribute: {
                id: attribute.id,
              },
            },
          },
        });
      }

      options?.map(async (option) => {
        return await prisma.attributeToUser.upsert({
          where: {
            memberId_attributeOptionId: {
              memberId: membership.id,
              attributeOptionId: option.value,
            },
          },
          create: {
            memberId: membership.id,
            attributeOptionId: option.value,
          },
          update: {}, // No update needed if it already exists
          select: {
            id: true,
          },
        });
      });
    }
  });

  // try {
  //   const results = await Promise.allSettled(promises);

  //   if (results.some((result) => result.status === "rejected")) {
  //     logger.error(`When assigning attributes to user ${input.userId}, some promises were rejected`, {
  //       userId: input.userId,
  //       attributes: input.attributes,
  //       error: results.filter((result) => result.status === "rejected").map((result) => result.reason),
  //     });
  //   }

  //   return results;
  // } catch (error) {
  //   throw error; // Re-throw the error for the caller to handle
  // }
};

export default assignUserToAttributeHandler;
